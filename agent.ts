// agent.ts
import OpenAI from "openai";
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

export type StopReason = "answered" | "budget";

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

const SYSTEM_TEMPLATE = `You are a research assistant. Today is {{WEEKDAY}}, {{DATE}} ({{ISO}}).

Your training data ends before this date. Never assume the current year,
price, version, or availability from memory. Any question that depends on
"now", "latest", "current", or "today" must be answered from a search you
perform in this conversation, not from memory.

Search whenever the answer depends on facts you cannot verify from this
conversation.

Do not add a year to a search query unless the user named one or the
question is explicitly about a past year.

Cite the source URL for every factual claim. If your retrieved sources do
not cover something, say so instead of filling the gap.`;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function renderSystemPrompt(now: Date): string {
  const weekday = WEEKDAYS[now.getDay()];
  const date = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const iso = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
    now.getDate()
  )}`;

  return SYSTEM_TEMPLATE.replaceAll("{{WEEKDAY}}", weekday)
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{ISO}}", iso);
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

async function turn(
  userText: string
): Promise<{ answer: string; stopReason: StopReason }> {
  // Rendered once per run so every step and the trace see the same instant.
  const instructions = renderSystemPrompt(new Date());
  const tracer = new Tracer(userText);
  tracer.runStart({
    model,
    command: `npm start -- ${JSON.stringify(userText)}`,
    promptVersion: promptVersion(SYSTEM_TEMPLATE),
    systemPrompt: instructions,
  });

  const input: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: userText },
  ];

  const runStart = performance.now();
  let totalTokens = 0;
  const searches: string[] = [];
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

const result = await turn(
  process.argv[2] ?? "What is the latest stable Node.js version?"
);
if (result.stopReason !== "answered") process.exitCode = 1;
