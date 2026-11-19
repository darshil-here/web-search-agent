// eval/runner.ts
//
// Executes the case set two ways. Offline drives the real pipeline modules with
// a stub LLM and search (free, deterministic, part of `npm test`). Live runs the
// real CLI in a throwaway session/database and judges the answer against the
// case rubric with the model, then writes a markdown report.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
acceptable when the rubric allows it. Judge ONLY the listed must and mustNot
items. Do not penalize the answer for problems that the rubric does not mention.

The retrieved sources below are evidence. A claim is supported when a retrieved
source states it, so a mustNot about an unsupported assertion does not apply to
a claim the sources state explicitly. Only mark a value unsupported when none of
the retrieved excerpts states it.

Memory context comes from the agent's own store. Zero turns found for the date
the question asks about is evidence that the conversation has no record on that
date; stating that absence is grounded, not invented. Judge every claim against
the evidence provided, including the tool log.

A seeded claim's recorded source is listed in the seeded history and is
intentionally not in the retrieved set. Citing it beside a historical value is
correct attribution, not an invented current citation. The source requirement
applies to a change or a value presented as current.`;

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
  answerKind: string | null;
  passed: boolean;
  reasons: string[];
  trace: string | null;
  error: string | null;
  sources: string[];
};

function readFinalFromTrace(
  traceDir: string,
  sessionId: string
): { content: string; answerKind: string | null } {
  // A case can exit before writing a trace (a startup failure, a killed
  // process). The sweep must report that case as failed, not lose the whole
  // report to ENOENT.
  if (!existsSync(traceDir)) return { content: "", answerKind: null };
  const files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const lines = readFileSync(join(traceDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (lines.some((line) => line.type === "run_start" && line.sessionId === sessionId)) {
      const final = [...lines].reverse().find((line) => line.type === "final");
      return {
        content: typeof final?.content === "string" ? final.content : "",
        answerKind:
          typeof final?.answerKind === "string" ? final.answerKind : null,
      };
    }
  }
  return { content: "", answerKind: null };
}

/** Read the JSONL trace lines for one run, or [] when it produced no trace. */
function traceLines(
  traceDir: string,
  sessionId: string
): Array<Record<string, unknown>> {
  if (!existsSync(traceDir)) return [];
  for (const file of readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(traceDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (
      lines.some(
        (line) => line.type === "run_start" && line.sessionId === sessionId
      )
    ) {
      return lines;
    }
  }
  return [];
}

/**
 * What the agent's own store said, and which searches the tool ran. The judge
 * needs both: "no turns on 3 November" is grounded in an empty recall, and a
 * mustNot about searching chat history can only be checked from the tool log.
 */
function readMemoryEvidence(
  traceDir: string,
  sessionId: string
): { dates: string[]; rows: number; claims: number; queries: string[] } {
  const lines = traceLines(traceDir, sessionId);
  const recall = lines.find((line) => line.type === "recall");
  const queries = lines
    .filter((line) => line.type === "tool_call")
    .map((line) =>
      String((line.args as Record<string, unknown> | undefined)?.query ?? "")
    )
    .filter((query) => query !== "");
  return {
    dates: (recall?.dates as string[] | undefined) ?? [],
    rows: Number(recall?.rows ?? 0),
    claims: Number(recall?.claims ?? 0),
    queries,
  };
}

/** The retrieved snippets, so the judge can tell a sourced claim from a guess. */
function readSourcesFromTrace(traceDir: string, sessionId: string): string[] {
  if (!existsSync(traceDir)) return [];
  const files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const lines = readFileSync(join(traceDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (
      lines.some(
        (line) => line.type === "run_start" && line.sessionId === sessionId
      )
    ) {
      // The judge must see the same evidence the agent had. A 600-char cap cut
      // Tavily snippets mid-list, so values like Supabase's "500 MB RAM" were
      // below the fold and the judge called them unsupported. Keep the whole
      // snippet and dedupe by URL, because the same page is often returned by
      // several searches in one turn.
      const byUrl = new Map<string, string>();
      const add = (url: unknown, content: unknown) => {
        const key = String(url ?? "");
        if (key === "") return;
        const text = String(content ?? "");
        const previous = byUrl.get(key);
        if (previous === undefined || text.length > previous.length) {
          byUrl.set(key, text);
        }
      };
      for (const line of lines.filter((l) => l.type === "tool_call")) {
        for (const result of (line.results ?? []) as Array<Record<string, unknown>>) {
          add(result.url, result.content);
        }
      }
      // A re-check searches in code rather than through the tool, so its
      // sources are on the recheck event. Without this the judge sees a
      // temporal answer with no sources and marks every change unsourced.
      for (const line of lines.filter((l) => l.type === "recheck")) {
        for (const result of (line.sources ?? []) as Array<Record<string, unknown>>) {
          add(result.url, result.content);
        }
      }
      // The critic grades against the snippet plus the fetched page. A page
      // can state a value the snippet omitted, and the judge needs the same
      // evidence the guard had.
      for (const line of lines.filter((l) => l.type === "critic")) {
        for (const result of (line.sources ?? []) as Array<Record<string, unknown>>) {
          add(result.url, result.text);
        }
      }
      return [...byUrl.entries()].map(([url, content]) => `${url} ${content}`);
    }
  }
  return [];
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
    answerKind: null,
    passed: false,
    reasons: [],
    trace: null,
    error: null,
    sources: [],
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

  const final = readFinalFromTrace(traceDir, sessionId);
  base.answer = final.content;
  base.answerKind = final.answerKind;
  if (!base.error && final.content === "" && !existsSync(traceDir)) {
    base.error = "the CLI produced no trace; it exited before answering";
  }
  const traceFile = existsSync(traceDir)
    ? readdirSync(traceDir).find((f) => f.endsWith(".md"))
    : undefined;
  base.trace = traceFile ? join(traceDir, traceFile) : null;
  base.sources = readSourcesFromTrace(traceDir, sessionId);
  const memory = readMemoryEvidence(traceDir, sessionId);

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
      (c) =>
        `claim ${c.localDate}: ${c.subject} / ${c.attribute} = ${c.value}` +
        (c.url ? ` (recorded source: ${c.url})` : "")
    ),
  ].join("\n");

  const judged = await judge.structured<{ pass: boolean; reasons: string[] }>({
    name: "eval_judge",
    schema: JUDGE_SCHEMA,
    instructions: JUDGE_INSTRUCTIONS,
    input:
      `RUBRIC:\n${rubricText}\n\n` +
      `SEEDED HISTORY (known to be true):\n${historyText || "(none)"}\n\n` +
      `MEMORY CONTEXT (the agent's own store, before this question):\n` +
      (memory.dates.length > 0 || memory.rows > 0 || memory.claims > 0
        ? `dates queried: ${memory.dates.join(", ") || "(none)"}; ` +
          `turns found: ${memory.rows}; claims found: ${memory.claims}`
        : "(no memory lookup recorded)") +
      `\n\nTOOL CALLS (web_search):\n` +
      (memory.queries.length > 0
        ? memory.queries.map((query) => `- ${query}`).join("\n")
        : "none") +
      `\n\nRETRIEVED SOURCES (what the agent actually saw):\n${
        base.sources.join("\n") || "(none)"
      }\n\n` +
      `ANSWER:\n${base.answer || "(empty answer)"}`,
  });
  base.passed = judged.data.pass;
  base.reasons = judged.data.reasons;

  // Keep the evidence for a failed case. The judge's reason alone cannot tell
  // whether the code guard, the retrieved sources, or the judge caused it.
  if (base.passed) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    // base.trace is already the full path (set above).
  }
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
    lines.push(
      "",
      "## Live (LLM-judged)",
      "",
      "| case | result | answer kind | reasons |",
      "|------|:------:|:-----------:|---------|"
    );
    for (const r of live) {
      lines.push(
        `| ${r.id} | ${r.passed ? "pass" : "FAIL"} | ${r.answerKind ?? "unknown"} | ` +
          `${r.reasons.join("; ").replace(/\|/g, "\\|")} |`
      );
    }

    // A judge reason is a verdict, not evidence. Keep the exact answer and the
    // sources the agent saw for every failed case so a regression is diagnosable.
    const failures = live.filter((r) => !r.passed);
    if (failures.length > 0) {
      lines.push("", "## Live failures (full answers)", "");
      for (const r of failures) {
        lines.push(
          `### ${r.id}`,
          "",
          `Answer kind: ${r.answerKind ?? "unknown"}`,
          "",
          "ANSWER:",
          "````",
          r.answer || "(empty)",
          "````",
          "",
          "SOURCES:"
        );
        lines.push(...(r.sources.length ? r.sources.map((s) => `- ${s}`) : ["(none)"]));
        lines.push("", `trace: ${r.trace ?? "none"}`, "");
      }
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
