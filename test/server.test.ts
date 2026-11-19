// server.test.ts — the HTTP layer only. runTurn is a stub, so no keys or network.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../src/agent.js";
import { appendTurn, openDb } from "../src/db.js";
import { createApp, type AppDeps } from "../src/server.js";

const db = openDb(":memory:");
const dir = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
writeFileSync(join(dir, "styles.css"), "body{}");
writeFileSync(join(dir, "app.js"), "1");
writeFileSync(join(dir, "phone.png"), "png");

let behavior: NonNullable<AppDeps["runTurn"]> = async () => {
  throw new Error("no stub set");
};
let server: Server;
let base: string;

before(async () => {
  const at = (iso: string) => new Date(iso);
  const ctx = (sessionId: string) => ({ db, sessionId, timeZone: "UTC" });
  appendTurn(ctx("a"), "user", "  first\n question  ", at("2026-11-01T10:00:00Z"));
  appendTurn(ctx("a"), "assistant", "an answer", at("2026-11-01T10:00:05Z"));
  appendTurn(ctx("b"), "user", "other chat", at("2026-11-02T09:00:00Z"));

  server = createApp({
    db,
    timeZone: "UTC",
    defaultSessionId: "local",
    runTurn: (args) => behavior(args),
    webDir: dir,
    phoneImagePath: join(dir, "phone.png"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function frames(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => {
      const [event, data] = frame.split("\n");
      return {
        event: event.slice("event: ".length),
        data: JSON.parse(data.slice("data: ".length)),
      };
    });
}

test("serves the page and assets", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await page.text(), "<h1>hi</h1>");
  assert.equal((await fetch(`${base}/assets/iphone.png`)).headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 204);
});

test("lists sessions newest first with title and preview", async () => {
  const body = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(body.timeZone, "UTC");
  assert.equal(body.defaultSessionId, "local");
  assert.deepEqual(
    body.sessions.map((s: { id: string }) => s.id),
    ["b", "a"]
  );
  const a = body.sessions[1];
  assert.equal(a.title, "first question");
  assert.equal(a.preview, "an answer");
  assert.equal(a.turns, 2);
  assert.equal(a.updatedAt, "2026-11-01T10:00:05.000Z");
});

test("returns messages oldest first; unknown session is empty", async () => {
  const body = await (await fetch(`${base}/api/sessions/a/messages`)).json();
  assert.deepEqual(
    body.messages.map((m: { role: string }) => m.role),
    ["user", "assistant"]
  );
  assert.equal(body.messages[0].localDate, "2026-11-01");

  const none = await (await fetch(`${base}/api/sessions/nope/messages`)).json();
  assert.deepEqual(none.messages, []);
  assert.equal((await fetch(`${base}/api/sessions/bad%20id/messages`)).status, 400);
});

test("streams status, delta, done in order", async () => {
  behavior = async ({ onEvent, command }) => {
    assert.equal(command, "npm run web");
    onEvent?.({ type: "status", stage: "search", text: "Searching", level: "info" });
    onEvent?.({ type: "delta", text: "hello" });
    onEvent?.({ type: "done", answerKind: "model", stopReason: "answered", ms: 5 });
    return { answer: "hello", stopReason: "answered", answerKind: "model", ms: 5 };
  };
  const res = await post({ sessionId: "s1", message: " hi " });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const out = await frames(res);
  assert.deepEqual(
    out.map((f) => f.event),
    ["status", "delta", "done"]
  );
  assert.deepEqual(out[2].data, { answerKind: "model", stopReason: "answered", ms: 5 });
});

test("emits error when runTurn throws", async () => {
  behavior = async () => {
    throw new Error("boom");
  };
  const out = await frames(await post({ sessionId: "s2", message: "x" }));
  assert.deepEqual(out, [{ event: "error", data: { message: "boom" } }]);
});

test("rejects bad input before streaming", async () => {
  assert.equal((await post({ sessionId: "s", message: "   " })).status, 400);
  assert.equal((await post({ sessionId: "bad id!", message: "x" })).status, 400);
  assert.equal((await post({ sessionId: "s", message: "x".repeat(8001) })).status, 400);
  assert.equal((await post("{nope")).status, 400);
  assert.equal((await post({ sessionId: "s", message: "x" }, { "Content-Type": "text/plain" })).status, 415);
});

test("rejects a foreign Host header", async () => {
  const port = (server.address() as AddressInfo).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/sessions", headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("runs for the same session are serialized", async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let n = 0;
  behavior = async ({ message, onEvent }) => {
    log.push(`start ${message}`);
    if (n++ === 0) await gate;
    log.push(`end ${message}`);
    onEvent?.({ type: "done", answerKind: "model", stopReason: "answered", ms: 1 });
    return { answer: "", stopReason: "answered", answerKind: "model", ms: 1 };
  };

  const first = post({ sessionId: "ser", message: "one" });
  await new Promise((r) => setTimeout(r, 50));
  const second = post({ sessionId: "ser", message: "two" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(log, ["start one"]);

  release();
  const out = await frames(await second);
  await (await first).text();
  assert.deepEqual(log, ["start one", "end one", "start two", "end two"]);
  assert.equal(out[0].event, "status");
  assert.equal(out[0].data.stage, "queue");
});

test("a client disconnect aborts the run", async () => {
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let flipped!: () => void;
  const aborted = new Promise<void>((resolve) => (flipped = resolve));
  behavior = async (args) => {
    signal = args.signal;
    args.signal?.addEventListener("abort", () => flipped());
    started();
    await aborted;
    throw new Error("aborted");
  };

  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify({ sessionId: "kill", message: "x" });
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/api/chat",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  });
  req.on("error", () => {});
  req.on("response", () => {});
  req.end(body);

  await running;
  req.destroy();
  await aborted;
  assert.equal(signal?.aborted, true);
});
