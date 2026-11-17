// The whole point of config.ts is that settings are read in one place and bad
// settings fail at startup, so these tests pin the defaults and the failures.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const REQUIRED = {
  MODEL: "gpt-test",
  OPENAI_API_KEY: "sk-test",
  TAVILY_API_KEY: "tvly-test",
};

test("the required keys are read and the rest default", () => {
  const config = loadConfig({ ...REQUIRED });

  assert.equal(config.model, "gpt-test");
  assert.equal(config.openaiApiKey, "sk-test");
  assert.equal(config.tavilyApiKey, "tvly-test");
  assert.equal(config.sessionId, "local");
  assert.equal(config.timeZone, "UTC");
  assert.equal(config.dbPath, "data/agent.db");
  assert.equal(config.tracesDir, "traces");
  assert.equal(config.maxSteps, 5);
  assert.equal(config.maxRecheckSearches, 8);
});

test("every optional key overrides its default", () => {
  const config = loadConfig({
    ...REQUIRED,
    SESSION_ID: "session-1",
    USER_TZ: "Asia/Kolkata",
    DB_PATH: "tmp/test.db",
    TRACES_DIR: "tmp/traces",
    MAX_STEPS: "9",
    MAX_RECHECK_SEARCHES: "2",
  });

  assert.equal(config.sessionId, "session-1");
  assert.equal(config.timeZone, "Asia/Kolkata");
  assert.equal(config.dbPath, "tmp/test.db");
  assert.equal(config.tracesDir, "tmp/traces");
  assert.equal(config.maxSteps, 9);
  assert.equal(config.maxRecheckSearches, 2);
});

test("a missing required key fails at startup", () => {
  assert.throws(() => loadConfig({ ...REQUIRED, MODEL: "" }), /MODEL is not set/);
  assert.throws(
    () => loadConfig({ ...REQUIRED, OPENAI_API_KEY: undefined }),
    /OPENAI_API_KEY is not set/
  );
});

test("the step bound must be a positive integer", () => {
  assert.throws(() => loadConfig({ ...REQUIRED, MAX_STEPS: "0" }), /MAX_STEPS/);
  assert.throws(() => loadConfig({ ...REQUIRED, MAX_STEPS: "2.5" }), /MAX_STEPS/);
  assert.throws(
    () => loadConfig({ ...REQUIRED, MAX_RECHECK_SEARCHES: "-1" }),
    /MAX_RECHECK_SEARCHES/
  );
});

test("an unknown time zone fails before the first turn", () => {
  assert.throws(
    () => loadConfig({ ...REQUIRED, USER_TZ: "Mars/Olympus" }),
    /Mars\/Olympus/
  );
});
