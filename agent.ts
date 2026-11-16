// agent.ts
import OpenAI from "openai";
import { Tracer, promptVersion } from "./trace.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const model = requireEnv("MODEL");

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

const instructions =
  "You are a research assistant. Search when the question needs current facts. Always cite URLs.";

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

async function turn(userText: string) {
  const tracer = new Tracer(userText);
  tracer.runStart({
    model,
    command: `npm start -- ${JSON.stringify(userText)}`,
    promptVersion: promptVersion(instructions),
    systemPrompt: instructions,
  });

  const input: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: userText },
  ];

  const runStart = performance.now();
  let totalTokens = 0;
  let lastStep = 0;

  try {
    for (let step = 0; step < 5; step++) {
      console.log(`\n--- step ${step}, ${input.length} items ---`);

      const llmStart = performance.now();
      const response = await openai.responses.create({
        model,
        instructions,
        input,
        tools,
        reasoning: { effort: "low" },
      });
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
        });
        return;
      }

      // Feed the model's own output back so it can see its reasoning and calls.
      input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));

      for (const call of functionCalls) {
        const args = JSON.parse(call.arguments);
        console.log(`[tool] ${call.name}(${args.query})`);

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

    // The loop hit its bound without a final answer; still write a trace.
    tracer.final({
      step: lastStep + 1,
      content: "",
      totalMs: performance.now() - runStart,
      totalTokens,
    });
  } finally {
    console.log(`trace: ${tracer.flush()}`);
  }
}

await turn(process.argv[2] ?? "What is the latest stable Node.js version?");
