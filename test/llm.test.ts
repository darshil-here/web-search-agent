// The model boundary is tested against a fake Responses API, so the loop's
// bookkeeping (what gets fed back, which events fire, when the budget runs out)
// is verified without a network call.
import test from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { createLlm, type TurnEvent } from "../src/llm.js";

const USAGE = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

function message(text: string, usage = USAGE) {
  return { output: [{ type: "message" }], output_text: text, usage };
}

function functionCall(name: string, callId: string, args: object, usage = USAGE) {
  return {
    output: [
      {
        type: "function_call",
        name,
        call_id: callId,
        arguments: JSON.stringify(args),
      },
    ],
    output_text: "",
    usage,
  };
}

/** A client that replays canned responses and keeps every request it saw. */
function fakeClient(responses: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  let next = 0;

  const client = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        const response = responses[next++];
        if (!response) throw new Error("the loop asked for one response too many");
        return response;
      },
    },
  } as unknown as OpenAI;

  return { client, requests };
}

test("structured parses the JSON answer and reports usage", async () => {
  const { client, requests } = fakeClient([
    {
      output: [{ type: "message" }],
      output_text: JSON.stringify({ claims: [{ subject: "Neon" }] }),
      usage: USAGE,
    },
  ]);

  const result = await createLlm(client, "test-model").structured<{
    claims: Array<{ subject: string }>;
  }>({
    name: "claims",
    schema: { type: "object" },
    instructions: "Extract claims.",
    input: "Neon has a free tier.",
  });

  assert.equal(result.data.claims[0].subject, "Neon");
  assert.deepEqual(result.usage, { prompt: 10, completion: 5, total: 15 });

  const request = requests[0];
  assert.equal(request.model, "test-model");
  assert.deepEqual(request.text, {
    format: {
      type: "json_schema",
      name: "claims",
      schema: { type: "object" },
      strict: true,
    },
  });
});

test("turn returns the answer when the model calls no tools", async () => {
  const { client } = fakeClient([message("It is 42.")]);
  const events: TurnEvent[] = [];

  const result = await createLlm(client, "test-model").turn({
    instructions: "Be brief.",
    input: [{ role: "user", content: "What is the answer?" }],
    search: async () => [],
    toolDescription: "Search the web.",
    maxSteps: 3,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { text: "It is 42.", stopReason: "answered" });
  assert.deepEqual(events.map((event) => event.type), ["step", "llm"]);
});

test("turn runs a search and feeds the result back before answering", async () => {
  const { client, requests } = fakeClient([
    functionCall("web_search", "call_1", { query: "neon pricing" }),
    message("Neon's free tier is 512 MB."),
  ]);
  const queries: string[] = [];
  const events: TurnEvent[] = [];

  const result = await createLlm(client, "test-model").turn({
    instructions: "Be brief.",
    input: [{ role: "user", content: "Neon free tier?" }],
    search: async (query) => {
      queries.push(query);
      return [
        { title: "Neon", url: "https://neon.com/pricing", content: "512 MB" },
      ];
    },
    toolDescription: "Search the web.",
    maxSteps: 3,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { text: "Neon's free tier is 512 MB.", stopReason: "answered" });
  assert.deepEqual(queries, ["neon pricing"]);

  // The model's own call and the tool's output must both be in the next input,
  // or the second response has no idea what it searched for.
  const secondInput = requests[1].input as Array<Record<string, unknown>>;
  assert.equal(
    secondInput[0].role,
    "user",
    "the original prompt stays at the front"
  );
  assert.equal(secondInput[1].type, "function_call");
  const output = secondInput[2] as { type: string; call_id: string; output: string };
  assert.equal(output.type, "function_call_output");
  assert.equal(output.call_id, "call_1");
  assert.deepEqual(JSON.parse(output.output), [
    { title: "Neon", url: "https://neon.com/pricing", content: "512 MB" },
  ]);

  assert.deepEqual(events.map((event) => event.type), [
    "step",
    "llm",
    "tool",
    "step",
    "llm",
  ]);
});

test("turn reports budget when a tool call is still pending at the step bound", async () => {
  const { client } = fakeClient([
    functionCall("web_search", "call_1", { query: "anything" }),
  ]);

  const result = await createLlm(client, "test-model").turn({
    instructions: "Be brief.",
    input: [{ role: "user", content: "Search please." }],
    search: async () => [],
    toolDescription: "Search the web.",
    maxSteps: 1,
  });

  assert.deepEqual(result, { text: "", stopReason: "budget" });
});

test("a missing usage block is reported as zeros, not dropped", async () => {
  const { client, requests } = fakeClient([
    { output: [{ type: "message" }], output_text: "ok" },
  ]);
  const events: TurnEvent[] = [];

  await createLlm(client, "test-model").turn({
    instructions: "Be brief.",
    input: [{ role: "user", content: "Hi." }],
    search: async () => [],
    toolDescription: "Search the web.",
    maxSteps: 1,
    onEvent: (event) => events.push(event),
  });

  const call = events.find((event) => event.type === "llm");
  assert.ok(call && call.type === "llm");
  assert.deepEqual(call.call.usage, { prompt: 0, completion: 0, total: 0 });
  assert.equal(requests[0].reasoning && (requests[0].reasoning as { effort: string }).effort, "low");
});
