// Every environment variable the process reads, read and validated in one
// place. Modules take what they need as arguments, so this is the only file
// that has to change when a setting is added, renamed or given a new default.
import { assertTimeZone } from "./dates.js";

export type Config = {
  model: string;
  openaiApiKey: string;
  tavilyApiKey: string;
  sessionId: string;
  timeZone: string;
  dbPath: string;
  tracesDir: string;
  maxSteps: number;
  maxRecheckSearches: number;
  maxPageFetches: number;
};

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and add your keys.`
    );
  }
  return value;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    model: requireEnv(env, "MODEL"),
    openaiApiKey: requireEnv(env, "OPENAI_API_KEY"),
    tavilyApiKey: requireEnv(env, "TAVILY_API_KEY"),
    sessionId: env.SESSION_ID ?? "local",
    timeZone: env.USER_TZ ?? "UTC",
    dbPath: env.DB_PATH ?? "data/agent.db",
    tracesDir: env.TRACES_DIR ?? "traces",
    maxSteps: positiveInt(env, "MAX_STEPS", 5),
    maxRecheckSearches: positiveInt(env, "MAX_RECHECK_SEARCHES", 12),
    maxPageFetches: positiveInt(env, "MAX_PAGE_FETCHES", 6),
  };

  // Fail before the first turn, not halfway through an answer.
  assertTimeZone(config.timeZone);
  return config;
}
