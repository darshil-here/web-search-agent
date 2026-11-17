// The CLI and the per-turn control flow: recall, choose a path, answer, finish.
// Everything with a second caller lives in the modules below this one.
import { createInterface } from "node:readline";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { appendTurn, openDb, type SessionContext } from "./db.js";
import { extractClaims, recordClaims } from "./claims.js";
import { detectRecheck } from "./detect.js";
import { recheck } from "./recheck.js";
import { describeNow } from "./dates.js";
import { buildNotebook } from "./notebook.js";
import { createLlm, type StopReason, type ToolCall } from "./llm.js";
import { createSearch, type SearchResult } from "./search.js";
import { promptVersion, Tracer } from "./trace.js";

const config = loadConfig();
const search = createSearch(config.tavilyApiKey);
const llm = createLlm(new OpenAI({ apiKey: config.openaiApiKey }), config.model);

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
): Promise<void> {
  // No search means no external facts were introduced, so there is nothing to
  // put in the ledger. Skipping saves a model call on arithmetic/memory turns.
  if (sources.length === 0) return;

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
    tracer.claims({
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
    });
  } catch (err) {
    tracer.claims({
      extracted: 0,
      inserted: 0,
      superseded: 0,
      unchanged: 0,
      claims: [],
      error: message(err),
    });
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
  now: Date
): { answer: string; stopReason: StopReason } {
  tracer.final({
    steps,
    content: stopReason === "answered" ? answer : "",
    totalMs: performance.now() - runStart,
    stopReason,
  });

  if (stopReason === "answered" && answer.trim() !== "") {
    appendTurn(ctx, "assistant", answer, now);
  }

  return { answer, stopReason };
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
  ctx: SessionContext
): Promise<{ answer: string; stopReason: StopReason }> {
  // One instant per turn, so the prompt, the notebook, both turns and the
  // ledger all agree on what day it is.
  const now = new Date();
  const instructions = renderSystemPrompt(now, ctx.timeZone);
  const tracer = new Tracer(userText, config.tracesDir);

  tracer.runStart({
    model: config.model,
    command: INVOCATION,
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
    bytes: notebook.bytes,
    truncated: notebook.truncated,
  });

  appendTurn(ctx, "user", userText, now);

  const runStart = performance.now();
  try {
    // Temporal questions take a dedicated, deterministic path. It stays inside
    // the try so the finally below always flushes the trace.
    const intent = detectRecheck(userText, now, ctx.timeZone);
    if (intent) {
      const report = await recheck({
        ctx,
        intent,
        userText,
        now,
        llm,
        instructions,
        search,
        maxSearches: config.maxRecheckSearches,
        notebookText: notebook.text,
      });

      for (const call of report.llmCalls) tracer.llmCall(call);
      tracer.recheck(report);
      tracer.log(
        report.stopReason === "budget"
          ? `\nFINAL (incomplete):\n${report.answer}`
          : `\nRECHECK (${report.intent.date}):\n${report.answer}`
      );

      return conclude(
        ctx,
        tracer,
        report.answer,
        report.stopReason,
        report.llmCalls.length,
        runStart,
        now
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
      search,
      toolDescription: "Search the web. Use for anything current or factual.",
      maxSteps: config.maxSteps,
      onEvent: (event) => {
        if (event.type === "step") {
          tracer.log(`\n--- step ${event.step}, ${event.items} items ---`);
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

    if (result.stopReason === "budget") {
      const answer = budgetAnswer(searches, config.maxSteps);
      tracer.log("\nFINAL (incomplete):\n" + answer);
      return conclude(ctx, tracer, answer, "budget", modelCalls, runStart, now);
    }

    tracer.log("\nFINAL:\n" + result.text);
    if (result.text.trim() !== "") {
      await ledger(ctx, tracer, result.text, sources, now, userText);
    }

    return conclude(ctx, tracer, result.text, "answered", modelCalls, runStart, now);
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

const db = openDb(config.dbPath);
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
