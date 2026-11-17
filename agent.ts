// agent.ts
import { createInterface } from "node:readline";
import OpenAI from "openai";
import { openDb, saveTurn } from "./db.js";
import {
  extractClaims,
  recordClaims,
  type ClaimSource,
} from "./claims.js";
import { assertTimeZone, describeNow, localDateInTz } from "./dates.js";
import {
  buildNotebook,
  type NotebookContext,
} from "./notebook.js";
import { Tracer, promptVersion } from "./trace.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const model = requireEnv("MODEL");

// The loop bound exists so a search-happy model cannot run forever. It must be
// visible when it fires: an exhausted budget is a failed answer, not an answer.
// Env-overridable so the eval harness can test the bound for one cent.
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 5);
if (!Number.isInteger(MAX_STEPS) || MAX_STEPS < 1) {
  throw new Error(
    `MAX_STEPS must be a positive integer, got ${process.env.MAX_STEPS}`
  );
}

// "local" is a single-user CLI default. The column exists for the day there is
// more than one conversation; until then, do not pretend there is a session
// manager, just read the env var.
const SESSION_ID = process.env.SESSION_ID ?? "local";
const TIME_ZONE = process.env.USER_TZ ?? "UTC";
assertTimeZone(TIME_ZONE);

export type StopReason = "answered" | "budget";

type Context = NotebookContext;

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

const tools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "web_search",
    description: "Search the web. Use for anything current or factual.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: false,
  },
];

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

async function webSearch(query: string) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({ query, max_results: 5 }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results.map((r: any) => ({
    title: r.title,
    url: r.url,
    content: r.content,
  }));
}

// Post-answer claim recording. This is pipeline code, not a second tool: the
// model still exposes exactly one tool (web_search). It is deliberately
// best-effort — a ledger failure must never turn a good answer into a failed
// turn, so errors are traced rather than thrown.
async function ledger(
  ctx: Context,
  tracer: Tracer,
  answer: string,
  sources: ClaimSource[],
  now: Date
): Promise<void> {
  // No search means no external facts were introduced, so there is nothing to
  // put in the ledger. Skipping saves an LLM call on arithmetic/memory turns.
  if (sources.length === 0) return;

  try {
    const extracted = await extractClaims(openai, model, answer, sources);
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
      claims: result.claims.map((c) => ({
        subject: c.subject,
        attribute: c.attribute,
        value: c.value,
        url: c.url,
      })),
    });
  } catch (err) {
    tracer.claims({
      extracted: 0,
      inserted: 0,
      superseded: 0,
      unchanged: 0,
      claims: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function turn(
  userText: string,
  ctx: Context
): Promise<{ answer: string; stopReason: StopReason }> {
  // Rendered once per turn so every step and the trace see the same instant.
  const now = new Date();
  const instructions = renderSystemPrompt(now, ctx.timeZone);
  const tracer = new Tracer(userText);
  tracer.runStart({
    model,
    command:
      process.argv[2] !== undefined
        ? `npm start -- ${JSON.stringify(userText)}`
        : "npm run dev (repl)",
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

  saveTurn(ctx.db, {
    sessionId: ctx.sessionId,
    role: "user",
    content: userText,
    createdAt: now.toISOString(),
    localDate: localDateInTz(now, ctx.timeZone),
  });

  const input: OpenAI.Responses.ResponseInputItem[] = [
    { role: "developer", content: notebook.text },
    { role: "user", content: userText },
  ];

  const runStart = performance.now();
  let totalTokens = 0;
  const searches: string[] = [];
  // Deduplicated by URL: the same page can appear in several searches, and the
  // extractor should not pay to read it twice.
  const sources: ClaimSource[] = [];
  let lastStep = 0;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      console.log(`\n--- step ${step}, ${input.length} items ---`);

      const llmStart = performance.now();
      let response: OpenAI.Responses.Response;
      try {
        response = await openai.responses.create({
          model,
          instructions,
          input,
          tools,
          reasoning: { effort: "low" },
        });
      } catch (err) {
        tracer.error({
          step,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const llmMs = performance.now() - llmStart;

      if (!response.usage) throw new Error(`No usage returned for step ${step}`);

      const functionCalls = response.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
          item.type === "function_call"
      );

      const usage = {
        prompt: response.usage.input_tokens,
        completion: response.usage.output_tokens,
        total: response.usage.total_tokens,
      };
      totalTokens += usage.total;
      lastStep = step;
      tracer.llmCall({
        step,
        ms: llmMs,
        usage,
        toolCallCount: functionCalls.length,
      });

      if (functionCalls.length === 0) {
        console.log("\nFINAL:\n" + response.output_text);
        tracer.final({
          step,
          content: response.output_text,
          totalMs: performance.now() - runStart,
          totalTokens,
          stopReason: "answered",
        });

        if (response.output_text.trim() !== "") {
          saveTurn(ctx.db, {
            sessionId: ctx.sessionId,
            role: "assistant",
            content: response.output_text,
            createdAt: new Date().toISOString(),
            localDate: localDateInTz(new Date(), ctx.timeZone),
          });
          // Uses the turn's `now` so the claim's local_date agrees with the
          // question it answers, even across a midnight boundary.
          await ledger(ctx, tracer, response.output_text, sources, now);
        }

        return { answer: response.output_text, stopReason: "answered" };
      }

      // Feed the model's own output back so it can see its reasoning and calls.
      input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));

      for (const call of functionCalls) {
        const args = JSON.parse(call.arguments);
        console.log(`[tool] ${call.name}(${args.query})`);
        searches.push(args.query);

        const toolStart = performance.now();
        const results = await webSearch(args.query);
        for (const result of results) {
          if (!sources.some((s) => s.url === result.url)) sources.push(result);
        }
        tracer.toolCall({
          step,
          name: call.name,
          args,
          ms: performance.now() - toolStart,
          results,
        });
        console.log(`[result] ${results.length} hits`);

        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(results),
        });
      }
    }

    // The loop hit its bound without a final answer. Say so, loudly, and in a
    // shape the caller can check: silence here looks like a hang to a user and
    // like success to a script.
    const answer =
      `I stopped after ${MAX_STEPS} steps without an answer. ` +
      `Searches run: ${searches.join(" | ") || "none"}. ` +
      `Narrow the question or ask for one part at a time.`;

    console.log("\nFINAL (incomplete):\n" + answer);
    tracer.final({
      step: lastStep + 1,
      content: "",
      totalMs: performance.now() - runStart,
      totalTokens,
      stopReason: "budget",
    });
    return { answer, stopReason: "budget" };
  } finally {
    console.log(`trace: ${tracer.flush()}`);
  }
}

async function chat(ctx: Context): Promise<void> {
  const interactive = process.stdin.isTTY === true;
  const prompt = interactive ? "you> " : "";

  console.log(
    `session "${ctx.sessionId}", timezone ${ctx.timeZone}, model ${model}. ` +
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
      console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
    }

    process.stdout.write(prompt);
  }
}

const db = openDb();
const ctx: Context = { db, sessionId: SESSION_ID, timeZone: TIME_ZONE };

try {
  if (process.argv[2] !== undefined) {
    const result = await turn(process.argv[2], ctx);
    if (result.stopReason !== "answered") process.exitCode = 1;
  } else {
    await chat(ctx);
  }
} finally {
  db.close();
}
