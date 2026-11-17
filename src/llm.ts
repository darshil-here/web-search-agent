// The model boundary. Everything that talks to the Responses API does it here,
// so callers deal in "a turn with the search tool" and "a structured answer",
// not SDK shapes. The loop emits events as they happen; callers decide how to
// print them and what to trace, which keeps this module free of both.
import type OpenAI from "openai";
import type { SearchResult } from "./search.js";

export type Usage = { prompt: number; completion: number; total: number };

/** How a turn ended. "budget" means the step bound ran out without an answer. */
export type StopReason = "answered" | "budget";

export type LlmCall = {
  /** What the call was for: "answer", "claims", "extract". Shown in the trace. */
  label: string;
  /** Loop step, or null for a one-shot call outside the loop. */
  step: number | null;
  ms: number;
  usage: Usage;
};

export type ToolCall = {
  step: number;
  name: string;
  args: unknown;
  ms: number;
  results: SearchResult[];
};

export type TurnEvent =
  | { type: "step"; step: number; items: number }
  | { type: "llm"; call: LlmCall }
  | { type: "tool"; call: ToolCall };

export type PromptMessage = { role: "developer" | "user"; content: string };

export type StructuredRequest = {
  /** Schema name the API requires; also names the output shape in traces. */
  name: string;
  schema: Record<string, unknown>;
  instructions: string;
  input: string;
};

export type TurnRequest = {
  instructions: string;
  input: PromptMessage[];
  search: (query: string) => Promise<SearchResult[]>;
  /** What the single web_search tool is for, phrased for this caller's turn. */
  toolDescription: string;
  maxSteps: number;
  onEvent?: (event: TurnEvent) => void;
};

export type TurnResult = { text: string; stopReason: StopReason };

export interface Llm {
  structured<T>(request: StructuredRequest): Promise<{ data: T; usage: Usage }>;
  turn(request: TurnRequest): Promise<TurnResult>;
}

type SdkUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

function toUsage(usage: SdkUsage | undefined): Usage {
  // A missing usage block is a real absence, not zero: the trace shows zeros so
  // an untracked call is visible instead of silently priced at nothing.
  return {
    prompt: usage?.input_tokens ?? 0,
    completion: usage?.output_tokens ?? 0,
    total: usage?.total_tokens ?? 0,
  };
}

function searchTool(description: string): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: "web_search",
    description,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: false,
  };
}

class ModelLlm implements Llm {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async structured<T>(
    request: StructuredRequest
  ): Promise<{ data: T; usage: Usage }> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: request.instructions,
      input: request.input,
      text: {
        format: {
          type: "json_schema",
          name: request.name,
          schema: request.schema,
          strict: true,
        },
      },
    });

    return {
      data: JSON.parse(response.output_text) as T,
      usage: toUsage(response.usage),
    };
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const emit = request.onEvent ?? (() => {});
    const tools = [searchTool(request.toolDescription)];
    const input: OpenAI.Responses.ResponseInputItem[] = request.input.map(
      (message) => ({ role: message.role, content: message.content })
    );

    for (let step = 0; step < request.maxSteps; step++) {
      emit({ type: "step", step, items: input.length });

      const started = performance.now();
      const response = await this.client.responses.create({
        model: this.model,
        instructions: request.instructions,
        input,
        tools,
        reasoning: { effort: "low" },
      });
      const calls = response.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
          item.type === "function_call"
      );

      emit({
        type: "llm",
        call: {
          label: "answer",
          step,
          ms: performance.now() - started,
          usage: toUsage(response.usage),
        },
      });

      if (calls.length === 0) {
        return { text: response.output_text, stopReason: "answered" };
      }

      // Feed the model's own output back so it can see its reasoning and calls.
      input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));

      for (const call of calls) {
        const args = JSON.parse(call.arguments) as { query?: string };
        const toolStarted = performance.now();
        const results = await request.search(args.query ?? "");
        const toolCall: ToolCall = {
          step,
          name: call.name,
          args,
          ms: performance.now() - toolStarted,
          results,
        };

        emit({ type: "tool", call: toolCall });
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(results),
        });
      }
    }

    return { text: "", stopReason: "budget" };
  }
}

export function createLlm(client: OpenAI, model: string): Llm {
  return new ModelLlm(client, model);
}
