// trace.ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

const TRACES_DIR = "traces";

export type TokenUsage = {
  prompt: number;
  completion: number;
  total: number;
};

export type ToolResult = {
  title: string;
  url: string;
  content: string;
};

type RunStart = {
  model: string;
  command: string;
  promptVersion: string;
  systemPrompt: string;
  sessionId: string;
  timeZone: string;
};

type Recall = {
  mode: "dates" | "recent";
  refs: string[];
  dates: string[];
  rows: number;
  bytes: number;
  truncated: boolean;
};

type LlmCall = {
  step: number;
  ms: number;
  usage: TokenUsage;
  toolCallCount: number;
};

type ToolCall = {
  step: number;
  name: string;
  args: unknown;
  ms: number;
  results: ToolResult[];
};

type Final = {
  step: number;
  content: string;
  totalMs: number;
  totalTokens: number;
  stopReason: "answered" | "budget";
};

type TraceError = {
  step: number;
  message: string;
};

type TraceEvent = {
  type: string;
  ts: string;
  [key: string]: unknown;
};

export function promptVersion(instructions: string): string {
  return createHash("sha256").update(instructions).digest("hex").slice(0, 8);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function datePart(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timePart(date: Date): string {
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function slugify(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "run";
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export class Tracer {
  private readonly question: string;
  private readonly startedAt: Date;
  private readonly rawLines: string[] = [];
  private readonly llmCalls: LlmCall[] = [];
  private readonly toolCalls: ToolCall[] = [];
  private readonly events: TraceEvent[] = [];
  private readonly errors: TraceError[] = [];
  private readonly originalLog = console.log.bind(console);
  private meta: RunStart | undefined;
  private finalInfo: Final | undefined;
  private recallInfo: Recall | undefined;
  private flushedPath: string | undefined;

  constructor(question: string) {
    this.question = question;
    this.startedAt = new Date();
  }

  runStart(meta: RunStart): void {
    this.meta = meta;
    this.events.push({
      type: "run_start",
      ts: new Date().toISOString(),
      model: meta.model,
      command: meta.command,
      sessionId: meta.sessionId,
      timeZone: meta.timeZone,
      promptVersion: meta.promptVersion,
      systemPrompt: meta.systemPrompt.slice(0, 4000),
    });

    // Tee console.log into the trace while keeping the terminal output identical.
    console.log = (...args: unknown[]) => {
      this.rawLines.push(format(...args));
      this.originalLog(...args);
    };
  }

  llmCall(call: LlmCall): void {
    this.llmCalls.push(call);
    this.events.push({
      type: "llm_call",
      ts: new Date().toISOString(),
      ...call,
    });
  }

  recall(info: Recall): void {
    this.recallInfo = info;
    this.events.push({ type: "recall", ts: new Date().toISOString(), ...info });
  }

  toolCall(call: ToolCall): void {
    this.toolCalls.push(call);
    this.events.push({
      type: "tool_call",
      ts: new Date().toISOString(),
      step: call.step,
      name: call.name,
      args: call.args,
      ms: call.ms,
      resultCount: call.results.length,
      results: call.results.map((result) => ({
        title: result.title,
        url: result.url,
        content: result.content.slice(0, 2000),
      })),
    });
  }

  final(info: Final): void {
    this.finalInfo = info;
    this.events.push({
      type: "final",
      ts: new Date().toISOString(),
      ...info,
    });
  }

  error(info: TraceError): void {
    this.errors.push(info);
    this.events.push({
      type: "error",
      ts: new Date().toISOString(),
      step: info.step,
      message: info.message,
    });
  }

  flush(): string {
    if (this.flushedPath) return this.flushedPath;

    // Stop capturing before the caller prints the trace pointer line.
    console.log = this.originalLog;

    const base = `${datePart(this.startedAt)}-${timePart(this.startedAt)}-${slugify(
      this.question
    )}`;
    const mdPath = join(TRACES_DIR, `${base}.md`);
    const jsonlPath = join(TRACES_DIR, `${base}.jsonl`);

    mkdirSync(TRACES_DIR, { recursive: true });
    writeFileSync(mdPath, this.renderMarkdown(), "utf8");
    writeFileSync(
      jsonlPath,
      this.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8"
    );

    this.flushedPath = mdPath;
    return mdPath;
  }

  private verdict(): string {
    if (this.errors.length > 0) return "error";
    if (this.finalInfo?.stopReason === "budget") return "incomplete";
    if (this.finalInfo?.stopReason === "answered") return "ok";
    return "unset";
  }

  private renderMarkdown(): string {
    const meta = this.meta ?? {
      model: "unknown",
      command: "unknown",
      promptVersion: "unknown",
      systemPrompt: "",
      sessionId: "unknown",
      timeZone: "unknown",
    };

    const rows = this.llmCalls.map((call) => {
      const callsThisStep = this.toolCalls.filter((t) => t.step === call.step);
      return {
        step: call.step,
        llmMs: Math.round(call.ms),
        toolsMs: callsThisStep.reduce((sum, t) => sum + Math.round(t.ms), 0),
        toolCalls: callsThisStep.length,
        prompt: call.usage.prompt,
        completion: call.usage.completion,
        total: call.usage.total,
      };
    });

    const totals = {
      llmMs: 0,
      toolsMs: 0,
      toolCalls: 0,
      prompt: 0,
      completion: 0,
      total: 0,
    };
    for (const row of rows) {
      totals.llmMs += row.llmMs;
      totals.toolsMs += row.toolsMs;
      totals.toolCalls += row.toolCalls;
      totals.prompt += row.prompt;
      totals.completion += row.completion;
      totals.total += row.total;
    }

    const totalMs = Math.round(
      this.finalInfo?.totalMs ?? totals.llmMs + totals.toolsMs
    );

    const lines: string[] = [
      "---",
      `date: ${datePart(this.startedAt)}`,
      `model: ${JSON.stringify(meta.model)}`,
      `session: ${JSON.stringify(meta.sessionId)}`,
      `timezone: ${JSON.stringify(meta.timeZone)}`,
      `command: ${JSON.stringify(meta.command)}`,
      `prompt_version: ${JSON.stringify(meta.promptVersion)}`,
      `steps: ${this.llmCalls.length}`,
      `tool_calls: ${this.toolCalls.length}`,
      "tokens:",
      `  prompt: ${totals.prompt}`,
      `  completion: ${totals.completion}`,
      `  total: ${totals.total}`,
      "latency_ms:",
      `  llm: ${totals.llmMs}`,
      `  tools: ${totals.toolsMs}`,
      `  total: ${totalMs}`,
      `verdict: ${this.verdict()}`,
      "failures: []",
      "---",
      "",
      `# Run: ${this.question}`,
      "",
      "## Raw output",
      "",
      "````",
      this.rawLines.join("\n"),
      "````",
      "",
      "## Summary",
      "",
      "| step | llm ms | tools ms | tool calls | prompt tokens | completion tokens | total tokens |",
      "|-----:|-------:|---------:|-----------:|--------------:|------------------:|-------------:|",
    ];

    for (const row of rows) {
      lines.push(
        `| ${row.step} | ${row.llmMs} | ${row.toolsMs} | ${row.toolCalls} | ${row.prompt} | ${row.completion} | ${row.total} |`
      );
    }

    lines.push(
      `| **total** | **${totals.llmMs}** | **${totals.toolsMs}** | **${totals.toolCalls}** | **${totals.prompt}** | **${totals.completion}** | **${totals.total}** |`
    );

    if (this.recallInfo) {
      const recall = this.recallInfo;
      lines.push(
        "",
        "## Notebook",
        "",
        `| mode | rows | bytes | truncated |`,
        "|------|-----:|------:|:----------|",
        `| ${recall.mode} | ${recall.rows} | ${recall.bytes} | ${recall.truncated} |`,
        ""
      );
      if (recall.refs.length > 0) {
        lines.push(`Dates parsed: ${recall.refs.join(", ")}`, "");
        lines.push(`Dates queried: ${recall.dates.join(", ") || "none"}`, "");
      }
    }

    if (this.finalInfo?.stopReason === "budget") {
      lines.push(
        "",
        "## Incomplete",
        "",
        "The loop hit its step bound with tool calls still pending. This is a failed answer, not an answer.",
        ""
      );
    }

    if (this.errors.length > 0) {
      lines.push("", "## Error", "");
      for (const error of this.errors) {
        lines.push(`**Step ${error.step}:**`, "", "````", error.message, "````", "");
      }
    }

    lines.push("", "## Sources", "");

    if (this.toolCalls.length === 0) {
      lines.push("_No tool calls._");
    } else {
      lines.push(
        "| step | title | URL | content length |",
        "|-----:|-------|-----|---------------:|"
      );
      for (const call of this.toolCalls) {
        for (const result of call.results) {
          lines.push(
            `| ${call.step} | ${tableCell(result.title)} | ${tableCell(
              result.url
            )} | ${result.content.length} |`
          );
        }
      }
    }

    return lines.join("\n") + "\n";
  }
}
