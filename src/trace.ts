// Per-run evidence: one .md for a human and one .jsonl for a script, recording
// what was injected, what the model did, what it cost and where it failed.
// This module records what it is given; callers own the printing.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import type { LlmCall, StopReason, ToolCall } from "./llm.js";
import { flatten, pad2 } from "./text.js";

export type ClaimEvent = {
  extracted: number;
  inserted: number;
  superseded: number;
  unchanged: number;
  claims: Array<{
    subject: string;
    attribute: string;
    value: string;
    url: string | null;
  }>;
  error?: string;
};

/**
 * What the re-check section needs. Declared here rather than imported from
 * recheck.ts so the trace layer does not depend on a pipeline it happens to
 * render; recheck's report is checked against this shape at the call site.
 */
export type RecheckTrace = {
  intent: { date: string; phrase: string };
  queries: string[];
  claimsChecked: number;
  failedSearches: number;
  usedSearch: boolean;
  writeBack: { inserted: number; superseded: number; verifications: number };
  fresh: Array<{
    claimId: number;
    value: string;
    url: string | null;
    status: string;
    mismatch?: boolean;
    matchedAttribute?: string | null;
  }>;
  errors: { extraction?: string; writeBack?: string; answer?: string };
  /** The sources the re-check actually searched, so the trace and the live
   * judge can see what the re-check saw. */
  sources?: Array<{
    title: string;
    url: string;
    content: string;
    publishedAt?: string | null;
  }>;
  answerKind?: "model" | "fallback";
  guard?: { rewritten: string[] };
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
  claims: number;
  bytes: number;
  truncated: boolean;
};

type Final = {
  steps: number;
  content: string;
  /** "model" is a model-written answer; "fallback" is code-rendered text. */
  answerKind?: "model" | "fallback";
  totalMs: number;
  stopReason: StopReason;
};

export type CriticTrace = {
  statements: number;
  dropped: number;
  replaced: string[];
  note: string | null;
  /** Snippet + fetched page for each source the guard graded against. */
  sources?: Array<{ url: string; text: string }>;
  error?: string;
};

export type ScopeTrace = { removed: string[] };

export type CalibrationTrace = { rewritten: string[] };

type TraceError = { message: string };

type TraceEvent = {
  type: string;
  ts: string;
  [key: string]: unknown;
};

export function promptVersion(instructions: string): string {
  return createHash("sha256").update(instructions).digest("hex").slice(0, 8);
}

function datePart(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}`;
}

function timePart(date: Date): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(
    date.getSeconds()
  )}`;
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
  return flatten(value).replace(/\|/g, "\\|");
}

export class Tracer {
  private readonly startedAt = new Date();
  private readonly rawLines: string[] = [];
  private readonly llmCalls: LlmCall[] = [];
  private readonly toolCalls: ToolCall[] = [];
  private readonly events: TraceEvent[] = [];
  private readonly errors: TraceError[] = [];
  private meta: RunStart | undefined;
  private finalInfo: Final | undefined;
  private recallInfo: Recall | undefined;
  private claimInfo: ClaimEvent | undefined;
  private recheckInfo: RecheckTrace | undefined;
  private criticInfo: CriticTrace | undefined;
  private scopeInfo: ScopeTrace | undefined;
  private calibrationInfo: CalibrationTrace | undefined;
  private flushedPath: string | undefined;

  constructor(
    private readonly question: string,
    private readonly dir: string
  ) {}

  /** The run's own output: printed and kept for the raw section of the trace. */
  log(...args: unknown[]): void {
    this.rawLines.push(format(...args));
    console.log(...args);
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

  claims(info: ClaimEvent): void {
    this.claimInfo = info;
    this.events.push({
      type: "claims",
      ts: new Date().toISOString(),
      ...info,
    });
  }

  critic(result: CriticTrace): void {
    this.criticInfo = result;
    this.events.push({ type: "critic", ts: new Date().toISOString(), ...result });
  }

  scope(result: ScopeTrace): void {
    this.scopeInfo = result;
    this.events.push({ type: "scope", ts: new Date().toISOString(), ...result });
  }

  calibration(result: CalibrationTrace): void {
    this.calibrationInfo = result;
    this.events.push({
      type: "calibration",
      ts: new Date().toISOString(),
      ...result,
    });
  }

  recheck(report: RecheckTrace): void {
    this.recheckInfo = report;
    this.events.push({
      type: "recheck",
      ts: new Date().toISOString(),
      ...report,
    });
  }

  error(info: TraceError): void {
    this.errors.push(info);
    this.events.push({
      type: "error",
      ts: new Date().toISOString(),
      message: info.message,
    });
  }

  flush(): string {
    if (this.flushedPath) return this.flushedPath;

    const base = `${datePart(this.startedAt)}-${timePart(
      this.startedAt
    )}-${slugify(this.question)}`;
    mkdirSync(this.dir, { recursive: true });

    const mdPath = join(this.dir, `${base}.md`);
    writeFileSync(mdPath, this.renderMarkdown(), "utf8");
    writeFileSync(
      join(this.dir, `${base}.jsonl`),
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
      const toolsThisCall =
        call.step === null
          ? []
          : this.toolCalls.filter((tool) => tool.step === call.step);
      return {
        label: call.label,
        step: call.step,
        llmMs: Math.round(call.ms),
        toolsMs: toolsThisCall.reduce((sum, tool) => sum + Math.round(tool.ms), 0),
        toolCalls: toolsThisCall.length,
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
      `model_calls: ${this.llmCalls.length}`,
      `tool_calls: ${this.toolCalls.length}`,
      `claims: ${this.claimInfo?.extracted ?? 0}`,
      `recheck_claims: ${this.recheckInfo?.claimsChecked ?? 0}`,
      `recheck_rewrites: ${this.recheckInfo?.guard?.rewritten.length ?? 0}`,
      `recheck_answer_kind: ${this.recheckInfo?.answerKind ?? "n/a"}`,
      `answer_kind: ${this.finalInfo?.answerKind ?? "n/a"}`,
      `critic_statements: ${this.criticInfo?.statements ?? 0}`,
      `critic_dropped: ${this.criticInfo?.dropped ?? 0}`,
      `critic_replaced: ${this.criticInfo?.replaced.length ?? 0}`,
      `scope_removed: ${this.scopeInfo?.removed.length ?? 0}`,
      `calibration_rewrites: ${this.calibrationInfo?.rewritten.length ?? 0}`,
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
      "| phase | step | llm ms | tools ms | tool calls | prompt tokens | completion tokens | total tokens |",
      "|-------|-----:|-------:|---------:|-----------:|--------------:|------------------:|-------------:|",
    ];

    for (const row of rows) {
      lines.push(
        `| ${row.label} | ${row.step ?? "–"} | ${row.llmMs} | ${row.toolsMs} | ` +
          `${row.toolCalls} | ${row.prompt} | ${row.completion} | ${row.total} |`
      );
    }

    lines.push(
      `| **total** | | **${totals.llmMs}** | **${totals.toolsMs}** | **${totals.toolCalls}** | ` +
        `**${totals.prompt}** | **${totals.completion}** | **${totals.total}** |`
    );

    if (this.recallInfo) {
      const recall = this.recallInfo;
      lines.push(
        "",
        "## Notebook",
        "",
        "| mode | rows | claims | bytes | truncated |",
        "|------|-----:|-------:|------:|:----------|",
        `| ${recall.mode} | ${recall.rows} | ${recall.claims} | ${recall.bytes} | ${recall.truncated} |`,
        ""
      );
      if (recall.refs.length > 0) {
        lines.push(`Dates parsed: ${recall.refs.join(", ")}`, "");
        lines.push(`Dates queried: ${recall.dates.join(", ") || "none"}`, "");
      }
    }

    if (this.claimInfo) {
      const c = this.claimInfo;
      lines.push(
        "",
        "## Claim ledger",
        "",
        "| extracted | inserted | superseded | unchanged |",
        "|----------:|---------:|-----------:|----------:|",
        `| ${c.extracted} | ${c.inserted} | ${c.superseded} | ${c.unchanged} |`,
        ""
      );
      if (c.error) lines.push(`**Extraction error:** ${c.error}`, "");
      if (c.claims.length === 0) {
        lines.push("_No claims recorded._", "");
      } else {
        lines.push(
          "| subject | attribute | value | url |",
          "|---------|-----------|-------|-----|"
        );
        for (const claim of c.claims) {
          lines.push(
            `| ${tableCell(claim.subject)} | ${tableCell(claim.attribute)} | ` +
              `${tableCell(claim.value)} | ${tableCell(claim.url ?? "—")} |`
          );
        }
        lines.push("");
      }
    }

    if (this.criticInfo) {
      const c = this.criticInfo;
      lines.push(
        "",
        "## Grounding critic",
        "",
        "| statements | dropped | replaced | note |",
        "|----------:|--------:|---------:|------|",
        `| ${c.statements} | ${c.dropped} | ${c.replaced.length} | ${tableCell(c.note ?? "—")} |`,
        ""
      );
      for (const value of c.replaced) {
        lines.push(`- replaced: ${tableCell(value)}`);
      }
      if (c.replaced.length > 0) lines.push("");
      if (c.error) lines.push(`**Critic error:** ${c.error}`, "");
    }

    if (this.scopeInfo) {
      lines.push("", "## Scope", "");
      if (this.scopeInfo.removed.length === 0) {
        lines.push("_Nothing removed._", "");
      } else {
        for (const sentence of this.scopeInfo.removed) {
          lines.push(`- removed: ${tableCell(sentence)}`);
        }
        lines.push("");
      }
    }

    if (this.calibrationInfo) {
      lines.push("", "## Calibration", "");
      if (this.calibrationInfo.rewritten.length === 0) {
        lines.push("_No rewrites._", "");
      } else {
        for (const sentence of this.calibrationInfo.rewritten) {
          lines.push(`- rewrote: ${tableCell(sentence)}`);
        }
        lines.push("");
      }
    }

    if (this.recheckInfo) {
      const r = this.recheckInfo;
      lines.push(
        "",
        "## Re-check",
        "",
        `Date queried: ${r.intent.date} | phrase: ${r.intent.phrase}`,
        "",
        "| claims checked | queries | failed searches | used search | inserted | superseded | verifications |",
        "|---------------:|--------:|----------------:|:------------|---------:|------------:|--------------:|",
        `| ${r.claimsChecked} | ${r.queries.length} | ${r.failedSearches} | ` +
          `${r.usedSearch} | ${r.writeBack.inserted} | ${r.writeBack.superseded} | ` +
          `${r.writeBack.verifications} |`,
        "",
        `Answer kind: ${r.answerKind ?? "model"}`,
        ""
      );
      if (r.errors.answer) {
        lines.push(`**Answer fallback:** ${r.errors.answer}`, "");
      }
      if (r.errors.extraction) {
        lines.push(`**Fresh-value extraction failed:** ${r.errors.extraction}`, "");
      }
      if (r.errors.writeBack) {
        lines.push(`**Ledger write-back failed:** ${r.errors.writeBack}`, "");
      }
      for (const fresh of r.fresh) {
        lines.push(
          `- claim ${fresh.claimId}: ${fresh.status} — ${fresh.value || "no value"} ${fresh.url ?? ""}`
        );
      }
      lines.push("");

      if (r.sources && r.sources.length > 0) {
        lines.push("### Re-check sources", "");
        lines.push("| title | URL |", "|-------|-----|");
        for (const source of r.sources) {
          lines.push(`| ${tableCell(source.title)} | ${tableCell(source.url)} |`);
        }
        lines.push("");
      }

      if (r.guard && r.guard.rewritten.length > 0) {
        lines.push("", "### Unverified claims", "");
        for (const sentence of r.guard.rewritten) {
          lines.push(`- rewrote: ${tableCell(sentence)}`);
        }
        lines.push("");
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
        lines.push("````", error.message, "````", "");
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
