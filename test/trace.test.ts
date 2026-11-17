// The trace is the run's evidence. These tests write to a temporary directory
// and read the rendered files back, so column drift and verdict changes fail
// here instead of surprising a reader after a run.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../src/trace.js";
import type { GroundResult } from "../src/critic.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trace-test-"));
}

const START = {
  model: "gpt-test",
  command: "ask",
  promptVersion: "abc12345",
  systemPrompt: "You are a research assistant.",
  sessionId: "local",
  timeZone: "Asia/Kolkata",
};

const EXTRACT_CALL = {
  label: "extract",
  step: null,
  ms: 120,
  usage: { prompt: 100, completion: 20, total: 120 },
};

test("calibration rewrites render in the trace", () => {
  const dir = tempDir();
  try {
    const tracer = new Tracer("test", dir);
    tracer.calibration({ rewritten: ["The plan is permanent."] });
    const original = console.log;
    console.log = () => {};
    let path: string;
    try {
      path = tracer.flush();
    } finally {
      console.log = original;
    }
    const text = readFileSync(path, "utf8");
    assert.match(text, /## Calibration/);
    assert.match(text, /calibration_rewrites: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("critic and scope phases render in the trace", () => {
  const dir = tempDir();
  try {
    const tracer = new Tracer("test", dir);
    const ground: GroundResult = {
      answer: "revised",
      statements: 3,
      dropped: 1,
      note: "No publication date was visible in the retrieved sources.",
      usage: { prompt: 1, completion: 1, total: 2 },
    };
    tracer.critic(ground);
    tracer.scope({ removed: ["the 27.x line is Alpha."] });
    const original = console.log;
    console.log = () => {};
    let path: string;
    try {
      path = tracer.flush();
    } finally {
      console.log = original;
    }
    const text = readFileSync(path, "utf8");
    assert.match(text, /## Grounding critic/);
    assert.match(text, /## Scope/);
    assert.match(text, /critic_statements: 3/);
    assert.match(text, /scope_removed: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a finished run renders its phases and an ok verdict", () => {
  const dir = tempDir();
  try {
    const tracer = new Tracer("What is the latest stable release?", dir);
    tracer.runStart(START);

    const original = console.log;
    console.log = () => {};
    try {
      tracer.log("searching for %s", "node");
    } finally {
      console.log = original;
    }

    tracer.llmCall(EXTRACT_CALL);
    tracer.toolCall({
      step: 0,
      name: "web_search",
      args: { query: "node release" },
      ms: 40,
      results: [
        { title: "Node", url: "https://nodejs.org", content: "v26 stable" },
      ],
    });
    tracer.recheck({
      intent: { date: "2026-11-03", phrase: "still correct" },
      queries: ["node release"],
      claimsChecked: 1,
      failedSearches: 0,
      usedSearch: true,
      writeBack: { inserted: 0, superseded: 0, verifications: 1 },
      fresh: [
        {
          claimId: 1,
          value: "v26",
          url: "https://nodejs.org",
          status: "unchanged",
        },
      ],
      errors: {},
    });
    tracer.final({
      steps: 2,
      content: "v26 is stable.",
      totalMs: 500,
      stopReason: "answered",
    });

    const path = tracer.flush();
    assert.match(path, /\.md$/);

    const markdown = readFileSync(path, "utf8");
    assert.match(markdown, /searching for node/);
    assert.match(markdown, /\| extract \|/);
    assert.match(markdown, /## Re-check/);
    assert.match(markdown, /verdict: ok/);

    const events = readFileSync(path.replace(/\.md$/, ".jsonl"), "utf8");
    assert.match(events, /"type":"run_start"/);
    assert.match(events, /"type":"recheck"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exhausted loop and a thrown error change the verdict", () => {
  const dir = tempDir();
  try {
    const tracer = new Tracer("Search forever", dir);
    tracer.runStart(START);

    const budget = new Tracer("Search until the budget runs out", dir);
    budget.runStart(START);
    budget.final({ steps: 1, content: "", totalMs: 10, stopReason: "budget" });
    const budgetMarkdown = readFileSync(budget.flush(), "utf8");

    assert.match(budgetMarkdown, /verdict: incomplete/);
    assert.match(budgetMarkdown, /## Incomplete/);

    tracer.error({ message: "Tavily 500" });
    tracer.final({
      steps: 1,
      content: "partial",
      totalMs: 10,
      stopReason: "answered",
    });
    const errorMarkdown = readFileSync(tracer.flush(), "utf8");

    assert.match(errorMarkdown, /verdict: error/);
    assert.match(errorMarkdown, /Tavily 500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
