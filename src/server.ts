// A thin local web front end for the agent. It adds no behavior of its own:
// every chat request is one `runTurn` call, and its events are written out as
// server-sent events. `agent.ts` is imported dynamically in the entry block so
// that `createApp` can be tested without model or search keys.
import { createReadStream, realpathSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import type { RunEvent, runTurn as RunTurn } from "./agent.js";
import { recentTurns } from "./db.js";

export type AppDeps = {
  db: Database.Database;
  timeZone: string;
  /** The one conversation the UI opens; the CLI's session by default. */
  defaultSessionId: string;
  runTurn: typeof RunTurn;
  webDir: string;
  phoneImagePath: string;
};

const SESSION_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 8000;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, path: string, type: string): void {
  const stream = createReadStream(path);
  stream.once("error", () => {
    if (!res.headersSent) json(res, 404, { error: "Not found" });
    else res.destroy();
  });
  stream.once("open", () => {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    stream.pipe(res);
  });
}

function hostAllowed(req: IncomingMessage): boolean {
  const header = req.headers.host ?? "";
  const hostname = header.startsWith("[")
    ? header.slice(0, header.indexOf("]") + 1)
    : header.split(":")[0];
  return ALLOWED_HOSTS.has(hostname.toLowerCase());
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, "Content-Type must be application/json");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function parseChatBody(body: unknown): { sessionId: string; message: string } {
  const { sessionId, message } = (body ?? {}) as Record<string, unknown>;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new HttpError(400, "sessionId must match [A-Za-z0-9._:-]{1,64}");
  }
  if (typeof message !== "string" || message.trim() === "") {
    throw new HttpError(400, "message must be a non-empty string");
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `message is over ${MAX_MESSAGE_CHARS} characters`);
  }
  return { sessionId, message: message.trim() };
}

const squash = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type SessionRow = {
  id: string;
  first_user: string | null;
  latest: string;
  updated_at: string;
  turns: number;
};

function listSessions(db: Database.Database) {
  const rows = db
    .prepare(
      `SELECT t.session_id AS id,
              (SELECT content FROM turns
                WHERE session_id = t.session_id AND role = 'user'
                ORDER BY id ASC LIMIT 1) AS first_user,
              (SELECT content FROM turns
                WHERE session_id = t.session_id
                ORDER BY id DESC LIMIT 1) AS latest,
              MAX(t.created_at) AS updated_at,
              COUNT(*) AS turns
         FROM turns t
        GROUP BY t.session_id
        ORDER BY MAX(t.id) DESC`
    )
    .all() as SessionRow[];

  return rows.map((row) => ({
    id: row.id,
    title: squash(row.first_user ?? "", 80),
    preview: squash(row.latest ?? "", 120),
    updatedAt: row.updated_at,
    turns: row.turns,
  }));
}

export function createApp(deps: AppDeps): Server {
  // Same-session requests run one after another; different sessions overlap.
  const lastRun = new Map<string, Promise<unknown>>();

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { sessionId, message } = parseChatBody(await readJson(req));

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const controller = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) controller.abort();
    });

    const send = (event: string, data: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
    }, 15_000);

    const previous = lastRun.get(sessionId);
    const run = (async () => {
      if (previous) {
        send("status", {
          stage: "queue",
          level: "info",
          text: "Finishing the previous message first",
        });
        await previous.catch(() => {});
      }
      if (controller.signal.aborted) return;

      try {
        await deps.runTurn({
          sessionId,
          message,
          signal: controller.signal,
          command: "npm run web",
          onEvent: (event: RunEvent) => {
            if (event.type === "status") {
              send("status", {
                stage: event.stage,
                text: event.text,
                level: event.level,
              });
            } else if (event.type === "delta") {
              send("delta", { text: event.text });
            } else {
              send("done", {
                answerKind: event.answerKind,
                stopReason: event.stopReason,
                ms: event.ms,
              });
            }
          },
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    lastRun.set(sessionId, run);
    await run;
    if (lastRun.get(sessionId) === run) lastRun.delete(sessionId);

    finished = true;
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) return json(res, 403, { error: "Forbidden host" });

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET") {
      const asset = STATIC_FILES[path];
      if (asset) return sendFile(res, join(deps.webDir, asset.file), asset.type);
      if (path === "/assets/iphone.png") {
        return sendFile(res, deps.phoneImagePath, "image/png");
      }
      if (path === "/favicon.ico") {
        res.writeHead(204);
        return void res.end();
      }
      if (path === "/api/sessions") {
        return json(res, 200, {
          timeZone: deps.timeZone,
          defaultSessionId: deps.defaultSessionId,
          sessions: listSessions(deps.db),
        });
      }
      const messages = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messages) {
        let id: string;
        try {
          id = decodeURIComponent(messages[1]);
        } catch {
          return json(res, 400, { error: "Bad session id" });
        }
        if (!SESSION_ID.test(id)) return json(res, 400, { error: "Bad session id" });
        return json(res, 200, {
          timeZone: deps.timeZone,
          messages: recentTurns(deps.db, id, 1000).map((turn) => ({
            id: turn.id,
            role: turn.role,
            content: turn.content,
            createdAt: turn.createdAt,
            localDate: turn.localDate,
          })),
        });
      }
    }

    if (method === "POST" && path === "/api/chat") return chat(req, res);

    return json(res, 404, { error: "Not found" });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      json(res, 500, { error: "Internal error" });
    });
  });
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const agent = await import("./agent.js");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const port = Number(process.env.PORT ?? 3000);
  const db = agent.getDb();

  const server = createApp({
    db,
    timeZone: agent.config.timeZone,
    defaultSessionId: agent.config.sessionId,
    runTurn: agent.runTurn,
    webDir: join(root, "web"),
    phoneImagePath: join(root, "iPhone 16 Pro - White Titanium - Portrait.png"),
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Set PORT to another value.`
        : `Server error: ${err.message}`
    );
    process.exit(1);
  });

  // Loopback only: the server is unauthenticated and spends the API keys.
  server.listen(port, "127.0.0.1", () => {
    console.log(`web chat: http://localhost:${port}`);
  });

  const shutdown = (): void => {
    server.close();
    server.closeAllConnections();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
