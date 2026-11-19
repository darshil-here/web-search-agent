// The CLI and the per-turn control flow: recall, choose a path, answer, finish.
// Everything with a second caller lives in the modules below this one.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { appendTurn, openDb, type SessionContext } from "./db.js";
import { extractClaims, recordClaims } from "./claims.js";
import { detectRecheck } from "./detect.js";
import { recheck, type AnswerKind } from "./recheck.js";
import { describeNow } from "./dates.js";
import { buildNotebook, withRecalledQuestion } from "./notebook.js";
import { createLlm, type StopReason, type ToolCall } from "./llm.js";
import {
  createSearch,
  rankByFreshness,
  type SearchResult,
  type EnrichedSource,
} from "./search.js";
import { createFetch, selectUrls } from "./pages.js";
import { extractSourceDate, relativeDateMention } from "./source-date.js";
import { ground, needsGrounding } from "./critic.js";
import { guardScope } from "./scope.js";
import { guardCalibration } from "./calibration.js";
import { promptVersion, Tracer } from "./trace.js";

export const config = loadConfig();
const search = createSearch(config.tavilyApiKey);
const fetchPages = createFetch(config.tavilyApiKey);
const llm = createLlm(new OpenAI({ apiKey: config.openaiApiKey }), config.model);

// Only meaningful when this file is the CLI entry point; the web server imports
// this module too and passes its own trace label to runTurn.
const SINGLE_QUESTION = process.argv[2];
const INVOCATION =
  SINGLE_QUESTION === undefined
    ? "npm run dev (repl)"
    : `npm start -- ${JSON.stringify(SINGLE_QUESTION)}`;

const SYSTEM_TEMPLATE = `You are a research assistant. Today is {{WEEKDAY}}, {{DATE}} ({{ISO}}). The user's timezone is {{TZ}}.

Your training data ends before this date. Never assume the current year,
price, version, or availability from memory. Any question that depends on
"now", "latest", "current", or "today" must be answered from a search you
perform in this conversation, not from memory.

Search whenever the answer depends on facts you cannot verify from this
conversation. Do not add a year to a search query unless the user named one,
or adding the current year steers results toward fresher pages. Never search
for a year that is not the current year unless the question is explicitly
about that year.

Cite the source URL for every factual claim. If your retrieved sources do
not cover something, say so instead of filling the gap. Answer the question
asked; mention adjacent versions, tiers or releases only if the user asks.

You may be given a <notebook> block with earlier turns from this conversation.
It is your only memory: you cannot see anything the user said outside it.
- Never search the web for the user's own questions or chat history.
- If the notebook says there are no turns on a date, say there are none.
  Never invent a question or an answer that is not in it.
- If the user asks whether an earlier answer is still correct, treat that
  answer as a claim to re-check, not as established fact.`;

function renderSystemPrompt(now: Date, timeZone: string): string {
  const { iso, human, weekday } = describeNow(now, timeZone);

  return SYSTEM_TEMPLATE.replaceAll("{{WEEKDAY}}", weekday)
    .replaceAll("{{DATE}}", human)
    .replaceAll("{{ISO}}", iso)
    .replaceAll("{{TZ}}", timeZone);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a caller (the web server) can watch while a turn runs. */
export type RunEvent =
  | {
      type: "status";
      stage:
        | "recall"
        | "model"
        | "search"
        | "recheck"
        | "grounding"
        | "claims"
        | "budget";
      text: string;
      level: "info" | "warn";
    }
  | { type: "delta"; text: string }
  | {
      type: "done";
      answerKind: AnswerKind;
      stopReason: StopReason;
      ms: number;
    };

type StatusEvent = Extract<RunEvent, { type: "status" }>;

type TurnHooks = {
  emit?: (event: RunEvent) => void;
  signal?: AbortSignal;
  command?: string;
};

type ClaimsSummary = Parameters<Tracer["claims"]>[0];

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

let sharedDb: Database.Database | undefined;

/** One connection per process, opened on first use. */
export function getDb(): Database.Database {
  sharedDb ??= openDb(config.dbPath);
  return sharedDb;
}

/**
 * Post-answer claim recording. This is pipeline code, not a second tool: the
 * model still exposes exactly one tool (web_search). It is deliberately
 * best-effort — a ledger failure must never turn a good answer into a failed
 * turn, so errors are traced rather than thrown.
 */
async function ledger(
  ctx: SessionContext,
  tracer: Tracer,
  answer: string,
  sources: SearchResult[],
  now: Date,
  question: string
): Promise<ClaimsSummary | null> {
  // No search means no external facts were introduced, so there is nothing to
  // put in the ledger. Skipping saves a model call on arithmetic/memory turns.
  if (sources.length === 0) return null;

  const started = performance.now();
  try {
    const { claims: extracted, usage } = await extractClaims(
      llm,
      answer,
      sources,
      question
    );
    tracer.llmCall({
      label: "claims",
      step: null,
      ms: performance.now() - started,
      usage,
    });

    const result = recordClaims(
      ctx.db,
      ctx.sessionId,
      extracted,
      now,
      ctx.timeZone
    );
    const summary: ClaimsSummary = {
      extracted: extracted.length,
      inserted: result.inserted,
      superseded: result.superseded,
      unchanged: result.unchanged,
      claims: result.claims.map((claim) => ({
        subject: claim.subject,
        attribute: claim.attribute,
        value: claim.value,
        url: claim.url,
      })),
    };
    tracer.claims(summary);
    return summary;
  } catch (err) {
    const summary: ClaimsSummary = {
      extracted: 0,
      inserted: 0,
      superseded: 0,
      unchanged: 0,
      claims: [],
      error: message(err),
    };
    tracer.claims(summary);
    return summary;
  }
}

/** Save and trace the end of a turn. Only real answers become conversation. */
function conclude(
  ctx: SessionContext,
  tracer: Tracer,
  answer: string,
  stopReason: StopReason,
  steps: number,
  runStart: number,
  now: Date,
  answerKind: AnswerKind
): { answer: string; stopReason: StopReason; answerKind: AnswerKind } {
  // Trace what the user actually saw, not an empty string. A fallback or a
  // budget message is evidence; the verdict and stopReason still say it failed.
  tracer.final({
    steps,
    content: answer,
    answerKind,
    totalMs: performance.now() - runStart,
    stopReason,
  });

  if (stopReason === "answered" && answer.trim() !== "") {
    appendTurn(ctx, "assistant", answer, now);
  }

  return { answer, stopReason, answerKind };
}

function budgetAnswer(searches: string[], maxSteps: number): string {
  return (
    `I stopped after ${maxSteps} steps without an answer. ` +
    `Searches run: ${searches.join(" | ") || "none"}. ` +
    `Narrow the question or ask for one part at a time.`
  );
}

async function turn(
  userText: string,
  ctx: SessionContext,
  hooks: TurnHooks = {}
): Promise<{ answer: string; stopReason: StopReason; answerKind: AnswerKind }> {
  const status = (
    stage: StatusEvent["stage"],
    text: string,
    level: StatusEvent["level"] = "info"
  ): void => hooks.emit?.({ type: "status", stage, text, level });
  // A no-op without a signal, so the CLI path is unchanged.
  const checkpoint = (): void => hooks.signal?.throwIfAborted();

  // The same search function for the model's tool and the re-check fan-out,
  // with progress reported around it. Errors pass through untouched.
  const trackedSearch = async (query: string): Promise<SearchResult[]> => {
    checkpoint();
    status("search", `Searching the web: ${query}`);
    try {
      const found = await search(query);
      status("search", `Found ${plural(found.length, "result")}`);
      return found;
    } catch (err) {
      status(
        "search",
        `Search failed for "${query}": ${message(err)}`,
        "warn"
      );
      throw err;
    }
  };

  // One instant per turn, so the prompt, the notebook, both turns and the
  // ledger all agree on what day it is.
  const now = new Date();
  const instructions = renderSystemPrompt(now, ctx.timeZone);
  const tracer = new Tracer(userText, config.tracesDir);

  tracer.runStart({
    model: config.model,
    command: hooks.command ?? INVOCATION,
    promptVersion: promptVersion(SYSTEM_TEMPLATE),
    systemPrompt: instructions,
    sessionId: ctx.sessionId,
    timeZone: ctx.timeZone,
  });

  // Read the notebook before writing the current question, or the model would
  // be handed its own prompt back as "memory".
  const notebook = buildNotebook(ctx, userText, now);
  tracer.recall({
    mode: notebook.mode,
    refs: notebook.refs.map((ref) => ref.label),
    dates: notebook.dates,
    rows: notebook.rows,
    claims: notebook.claims,
    bytes: notebook.bytes,
    truncated: notebook.truncated,
  });
  if (notebook.rows > 0 || notebook.claims > 0) {
    status(
      "recall",
      `Recalling ${plural(notebook.rows, "earlier turn")} and ${plural(
        notebook.claims,
        "known fact"
      )}`
    );
  }

  appendTurn(ctx, "user", userText, now);

  const runStart = performance.now();
  try {
    // Temporal questions take a dedicated, deterministic path. It stays inside
    // the try so the finally below always flushes the trace.
    const intent = detectRecheck(userText, now, ctx.timeZone);
    if (intent) {
      status(
        "recheck",
        `Re-check: comparing earlier answers for ${intent.date}`
      );
      const report = await recheck({
        ctx,
        intent,
        userText,
        now,
        llm,
        instructions,
        search: trackedSearch,
        maxSearches: config.maxRecheckSearches,
        notebookText: notebook.text,
        onPlan: ({ subjects }) => {
          const list = subjects.join(", ");
          status(
            "recheck",
            `Re-checking ${plural(subjects.length, "subject")}: ${
              list.length > 120 ? `${list.slice(0, 117)}...` : list
            }`
          );
        },
      });
      checkpoint();
      if (report.failedSearches > 0) {
        status(
          "recheck",
          `${report.failedSearches} of ${report.queries.length} searches failed`,
          "warn"
        );
      }

      const answer = withRecalledQuestion(
        ctx,
        report.intent.date,
        userText,
        report.answer
      );
      report.answer = answer;
      for (const call of report.llmCalls) tracer.llmCall(call);
      tracer.recheck(report);
      tracer.log(
        report.answerKind === "fallback"
          ? `\nRECHECK (${report.intent.date}, code-written answer):\n${answer}`
          : `\nRECHECK (${report.intent.date}):\n${answer}`
      );

      return conclude(
        ctx,
        tracer,
        answer,
        report.stopReason,
        report.llmCalls.length,
        runStart,
        now,
        report.answerKind
      );
    }

    const sources: SearchResult[] = [];
    const seenUrls = new Set<string>();
    const searches: string[] = [];
    let modelCalls = 0;

    const result = await llm.turn({
      instructions,
      input: [
        { role: "developer", content: notebook.text },
        { role: "user", content: userText },
      ],
      search: trackedSearch,
      toolDescription: "Search the web. Use for anything current or factual.",
      maxSteps: config.maxSteps,
      onEvent: (event) => {
        if (event.type === "step") {
          tracer.log(`\n--- step ${event.step}, ${event.items} items ---`);
          status(
            "model",
            `Thinking (step ${event.step + 1} of ${config.maxSteps})`
          );
          return;
        }
        if (event.type === "llm") {
          modelCalls++;
          tracer.llmCall(event.call);
          return;
        }

        const call: ToolCall = event.call;
        const query = (call.args as { query?: string }).query ?? "";
        searches.push(query);
        tracer.log(`[tool] ${call.name}(${query})`);
        tracer.toolCall(call);
        tracer.log(`[result] ${call.results.length} hits`);

        for (const found of call.results) {
          if (seenUrls.has(found.url)) continue;
          seenUrls.add(found.url);
          sources.push(found);
        }
      },
    });

    checkpoint();

    if (result.stopReason === "budget") {
      status(
        "budget",
        `Step budget exhausted (${config.maxSteps} of ${config.maxSteps}); stopped without an answer`,
        "warn"
      );
      const answer = budgetAnswer(searches, config.maxSteps);
      tracer.log("\nFINAL (incomplete):\n" + answer);
      return conclude(
        ctx,
        tracer,
        answer,
        "budget",
        modelCalls,
        runStart,
        now,
        "fallback"
      );
    }

    // Freshness is a retrieval decision: the model can only prefer a current
    // source if it sees it first, so rank before any of the answer post-steps.
    const rankedSources = rankByFreshness(sources);
    let answer = result.text;

    if (answer.trim() !== "" && rankedSources.length > 0 && !needsGrounding(answer)) {
      // The critic is skipped for simple answers, but F-006 still requires a
      // statement about date visibility. Snippets alone are enough to decide
      // this, so no page fetch or model call is needed on the fast path.
      //
      // Judge freshness against the page the answer actually cites: a dated
      // page elsewhere in the result set does not date this claim, and a page
      // showing only "Updated: 18 hours ago" has no visible publication date.
      const cited = [...answer.matchAll(/https?:\/\/[^\s)\]|,]+/g)].map(
        (match) => match[0]
      );
      const judged = cited.length
        ? rankedSources.filter((source) => cited.includes(source.url))
        : rankedSources;
      const hasDate = judged.some(
        (source) =>
          extractSourceDate(source.content) !== null ||
          (source.publishedAt !== null && source.publishedAt !== undefined)
      );
      // A relative timestamp is visible freshness, not a calendar date. Say so
      // even when metadata supplied a publishedAt: the reader cannot see it.
      const visibleDate = judged.some(
        (source) => extractSourceDate(source.content) !== null
      );
      const relative = judged
        .map((source) => relativeDateMention(source.content))
        .find((mention) => mention !== null);
      if (!visibleDate && relative) {
        answer += `\n\nThe cited page shows a relative update time ("${relative}"), not a calendar date.`;
      } else if (!hasDate) {
        answer += cited.length
          ? "\n\nNo publication date was visible on the cited page; treat the details as current as of this conversation."
          : "\n\nNo publication date was visible in the retrieved sources.";
      }
    }

    if (
      answer.trim() !== "" &&
      rankedSources.length > 0 &&
      needsGrounding(answer)
    ) {
      checkpoint();
      const urls = selectUrls(rankedSources, 2, config.maxPageFetches);
      status(
        "grounding",
        `Grounding: fetching ${plural(urls.length, "source page")} to check the numbers`
      );
      const pages = await fetchPages(urls);
      const enriched: EnrichedSource[] = rankedSources.map((source) => {
        const pageText = pages.find((p) => p.url === source.url)?.text ?? null;
        const text = `${source.content}\n${pageText ?? ""}`;
        return {
          ...source,
          pageText,
          publishedAt:
            extractSourceDate(text) ?? source.publishedAt ?? null,
        };
      });

      const grounded = await ground(llm, answer, enriched, userText);
      tracer.llmCall({
        label: "critic",
        step: null,
        ms: 0,
        usage: grounded.usage,
      });
      tracer.critic(grounded);
      if (grounded.error) {
        tracer.log(
          `(grounding critic failed: ${grounded.error}; using original answer)`
        );
        status(
          "grounding",
          `Grounding check failed: ${grounded.error}; using the original answer`,
          "warn"
        );
      } else if (grounded.replaced.length > 0) {
        status(
          "grounding",
          `Grounding: replaced ${plural(
            grounded.replaced.length,
            "unsupported value"
          )} with "not stated in sources"`
        );
      } else {
        status("grounding", "Grounding: every value is supported by a source");
      }
      answer = grounded.answer;
    }

    const calibrated = guardCalibration(userText, answer, rankedSources);
    tracer.calibration(calibrated);
    answer = calibrated.answer;

    const scoped = guardScope(userText, answer);
    tracer.scope(scoped);

    tracer.log("\nFINAL:\n" + scoped.answer);
    if (scoped.answer.trim() !== "") {
      checkpoint();
      if (sources.length > 0) status("claims", "Extracting claims to remember");
      const recorded = await ledger(
        ctx,
        tracer,
        scoped.answer,
        sources,
        now,
        userText
      );
      if (recorded?.error) {
        status(
          "claims",
          `Claim extraction failed (answer unaffected): ${recorded.error}`,
          "warn"
        );
      } else if (recorded) {
        status(
          "claims",
          `Claims extracted: ${recorded.extracted}; recorded ${plural(
            recorded.inserted,
            "new fact"
          )}${
            recorded.superseded > 0 ? `, ${recorded.superseded} superseded` : ""
          }`
        );
      }
    }

    return conclude(
      ctx,
      tracer,
      scoped.answer,
      "answered",
      modelCalls,
      runStart,
      now,
      "model"
    );
  } catch (err) {
    tracer.error({ message: message(err) });
    throw err;
  } finally {
    console.log(`trace: ${tracer.flush()}`);
  }
}

async function chat(ctx: SessionContext): Promise<void> {
  const interactive = process.stdin.isTTY === true;
  const prompt = interactive ? "you> " : "";

  console.log(
    `session "${ctx.sessionId}", timezone ${ctx.timeZone}, model ${config.model}. ` +
      `Type "exit" to stop.`
  );
  process.stdout.write(prompt);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "exit" || line === "quit") break;
    if (line === "") {
      process.stdout.write(prompt);
      continue;
    }

    try {
      const result = await turn(line, ctx);
      if (result.stopReason !== "answered") {
        console.error("(no answer: step budget exhausted, see the trace)");
      }
    } catch (err) {
      // A failed turn must not kill the session; the notebook is still valid.
      console.error(`\nerror: ${message(err)}`);
    }

    process.stdout.write(prompt);
  }
}

/**
 * The per-turn pipeline as a library call. Emits `status` while it works, then
 * one `delta` with the final text (the model call is not streamed and the
 * answer is rewritten by the grounding guards, so the finished text is the only
 * honest thing to show) and `done`. Throws on failure; no `done` is emitted.
 */
export async function runTurn(args: {
  sessionId: string;
  message: string;
  onEvent?: (event: RunEvent) => void;
  signal?: AbortSignal;
  command?: string;
}): Promise<{
  answer: string;
  stopReason: StopReason;
  answerKind: AnswerKind;
  ms: number;
}> {
  const started = performance.now();
  const ctx: SessionContext = {
    db: getDb(),
    sessionId: args.sessionId,
    timeZone: config.timeZone,
  };
  const result = await turn(args.message, ctx, {
    emit: args.onEvent,
    signal: args.signal,
    command: args.command,
  });
  const ms = Math.round(performance.now() - started);

  if (result.answer.trim() !== "") {
    args.onEvent?.({ type: "delta", text: result.answer });
  }
  args.onEvent?.({
    type: "done",
    answerKind: result.answerKind,
    stopReason: result.stopReason,
    ms,
  });
  return { ...result, ms };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const db = getDb();
  const ctx: SessionContext = {
    db,
    sessionId: config.sessionId,
    timeZone: config.timeZone,
  };

  try {
    if (SINGLE_QUESTION !== undefined) {
      const result = await turn(SINGLE_QUESTION, ctx);
      if (result.stopReason !== "answered") process.exitCode = 1;
    } else {
      await chat(ctx);
    }
  } finally {
    db.close();
  }
}
