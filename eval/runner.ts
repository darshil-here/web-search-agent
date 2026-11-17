// eval/runner.ts
//
// Executes the case set two ways. Offline drives the real pipeline modules with
// a stub LLM and search (free, deterministic, part of `npm test`). Live runs the
// real CLI in a throwaway session/database and judges the answer against the
// case rubric with the model, then writes a markdown report.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import type { Llm, Usage } from "../src/llm.js";
import { createLlm } from "../src/llm.js";
import type { SearchResult } from "../src/search.js";
import { openDb, saveClaim, saveTurn } from "../src/db.js";
import type { EvalCase, Observation } from "./cases.js";
import { NOW } from "./cases.js";

const zeroUsage: Usage = { prompt: 0, completion: 0, total: 0 };

/** A deterministic LLM stub: canned structured data, or a supplied turn result. */
function stubLlm(testCase: EvalCase): Llm {
  if (testCase.llm) return testCase.llm;
  return {
    structured: async <T>() => ({
      data: (testCase.structuredResponse ?? {}) as T,
      usage: zeroUsage,
    }),
    turn: async () => ({ text: "", stopReason: "budget" as const }),
  };
}

const stubSearch = async (): Promise<SearchResult[]> => [];

export type OfflineResult = {
  id: string;
  name: string;
  category: string;
  source: string;
  passed: boolean;
  failure: string | null;
  observation: Observation;
};

/** Run one case against the real modules with everything external stubbed. */
export async function runOffline(testCase: EvalCase): Promise<OfflineResult> {
  const dir = mkdtempSync(join(tmpdir(), "eval-offline-"));
  const dbPath = join(dir, "eval.db");
  const db = openDb(dbPath);
  const sessionId = `eval-${testCase.id}`;

  try {
    for (const seed of testCase.seed?.turns ?? []) {
      saveTurn(db, { sessionId, ...seed });
    }
    for (const seed of testCase.seed?.claims ?? []) {
      saveClaim(db, {
        sessionId,
        subject: seed.subject,
        attribute: seed.attribute,
        value: seed.value,
        url: seed.url ?? null,
        quote: seed.quote ?? null,
        observedAt: seed.observedAt,
        localDate: seed.localDate,
      });
    }

    const observation = await testCase.probe({
      db,
      sessionId,
      timeZone: "Asia/Kolkata",
      now: testCase.now ?? NOW,
      question: testCase.question,
      llm: stubLlm(testCase),
      search: stubSearch,
    });

    return {
      id: testCase.id,
      name: testCase.name,
      category: testCase.category,
      source: testCase.source,
      passed: true,
      failure: null,
      observation,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runOfflineAll(
  cases: EvalCase[]
): Promise<OfflineResult[]> {
  const results: OfflineResult[] = [];
  for (const testCase of cases) {
    const result = await runOffline(testCase);
    result.failure = testCase.check(result.observation);
    result.passed = result.failure === null;
    results.push(result);
  }
  return results;
}

// ---- Live mode ------------------------------------------------------------

const JUDGE_INSTRUCTIONS = `You grade a research assistant's answer against a rubric.

Return:
- pass: true only if every "must" item is satisfied and no "mustNot" item occurred
- reasons: a short list explaining the verdict, citing the answer where useful

Be strict about sources. An answer that asserts a change without a source does
not satisfy "source URL for each change". An honest "I could not verify" is
acceptable when the rubric allows it. Judge only the answer, not the rubric.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["pass", "reasons"],
  additionalProperties: false,
};

export type LiveResult = {
  id: string;
  name: string;
  source: string;
  answer: string;
  passed: boolean;
  reasons: string[];
  trace: string | null;
  error: string | null;
};

function readFinalFromTrace(traceDir: string, sessionId: string): string {
  const files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const lines = readFileSync(join(traceDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (lines.some((line) => line.type === "run_start" && line.sessionId === sessionId)) {
      const final = [...lines].reverse().find((line) => line.type === "final");
      return typeof final?.content === "string" ? final.content : "";
    }
  }
  return "";
}

/** Run one case through the real CLI, then judge its answer. */
export async function runLive(
  testCase: EvalCase,
  judge: Llm,
  env: NodeJS.ProcessEnv
): Promise<LiveResult> {
  const dir = mkdtempSync(join(tmpdir(), "eval-live-"));
  const dbPath = join(dir, "agent.db");
  const traceDir = join(dir, "traces");
  const sessionId = `eval-live-${testCase.id}`;

  // Seed the same history the offline probe sees, so both modes ask the same
  // question of the same remembered facts.
  const seedDb = openDb(dbPath);
  try {
    for (const seed of testCase.seed?.turns ?? []) {
      saveTurn(seedDb, { sessionId, ...seed });
    }
    for (const seed of testCase.seed?.claims ?? []) {
      saveClaim(seedDb, {
        sessionId,
        subject: seed.subject,
        attribute: seed.attribute,
        value: seed.value,
        url: seed.url ?? null,
        quote: seed.quote ?? null,
        observedAt: seed.observedAt,
        localDate: seed.localDate,
      });
    }
  } finally {
    seedDb.close();
  }

  const base: LiveResult = {
    id: testCase.id,
    name: testCase.name,
    source: testCase.source,
    answer: "",
    passed: false,
    reasons: [],
    trace: null,
    error: null,
  };

  try {
    execFileSync("npm", ["start", "--", testCase.question], {
      cwd: process.cwd(),
      env: {
        ...env,
        DB_PATH: dbPath,
        TRACES_DIR: traceDir,
        SESSION_ID: sessionId,
        MAX_STEPS: "5",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (err) {
    // A nonzero exit is expected for budget cases; the answer is still in the trace.
    base.error = err instanceof Error ? err.message.slice(0, 400) : String(err);
  }

  base.answer = readFinalFromTrace(traceDir, sessionId);
  base.trace = readdirSync(traceDir).find((f) => f.endsWith(".md")) ?? null;

  const rubricText =
    "MUST:\n" +
    testCase.rubric.must.map((item) => `- ${item}`).join("\n") +
    "\n\nMUST NOT:\n" +
    (testCase.rubric.mustNot ?? ["(nothing)"])
      .map((item) => `- ${item}`)
      .join("\n");

  // The judge sees only the answer, so give it the seeded history. Otherwise
  // it cannot tell a correctly recalled question from an invented one.
  const historyText = [
    ...(testCase.seed?.turns ?? []).map(
      (t) => `turn ${t.localDate} ${t.role}: ${t.content}`
    ),
    ...(testCase.seed?.claims ?? []).map(
      (c) => `claim ${c.localDate}: ${c.subject} / ${c.attribute} = ${c.value}`
    ),
  ].join("\n");

  const judged = await judge.structured<{ pass: boolean; reasons: string[] }>({
    name: "eval_judge",
    schema: JUDGE_SCHEMA,
    instructions: JUDGE_INSTRUCTIONS,
    input:
      `RUBRIC:\n${rubricText}\n\n` +
      `SEEDED HISTORY (known to be true):\n${historyText || "(none)"}\n\n` +
      `ANSWER:\n${base.answer || "(empty answer)"}`,
  });
  base.passed = judged.data.pass;
  base.reasons = judged.data.reasons;

  rmSync(dir, { recursive: true, force: true });
  return base;
}

export function renderReport(
  offline: OfflineResult[],
  live: LiveResult[]
): string {
  const lines = [
    "# Eval report",
    "",
    `Offline: ${offline.filter((r) => r.passed).length}/${offline.length} passed`,
    live.length ? `Live: ${live.filter((r) => r.passed).length}/${live.length} passed` : "Live: not run",
    "",
    "## Offline (deterministic)",
    "",
    "| case | source | result | note |",
    "|------|--------|:------:|------|",
  ];
  for (const r of offline) {
    lines.push(
      `| ${r.id} | ${r.source} | ${r.passed ? "pass" : "FAIL"} | ${r.failure ?? ""} |`
    );
  }
  if (live.length) {
    lines.push("", "## Live (LLM-judged)", "", "| case | result | reasons |", "|------|:------:|---------|");
    for (const r of live) {
      lines.push(
        `| ${r.id} | ${r.passed ? "pass" : "FAIL"} | ${r.reasons.join("; ").replace(/\|/g, "\\|")} |`
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function makeJudge(env: NodeJS.ProcessEnv): Llm {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.MODEL;
  if (!apiKey || !model) throw new Error("OPENAI_API_KEY and MODEL are required for live scoring");
  return createLlm(new OpenAI({ apiKey }), model);
}

export function readEnvFile(path = ".env"): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) out[match[1]] = match[2];
    }
  } catch {
    // The caller's environment may already carry the keys.
  }
  return { ...process.env, ...out };
}

export function writeReport(text: string): string {
  const path = join("eval", "results", `${Date.now()}.md`);
  writeFileSync(path, text, "utf8");
  return path;
}
