// Load the project's `.env` once, before any module reads `process.env`.
// Imported first by both entry points (`agent.ts` for the CLI, `server.ts` for
// the web app), so `npm run dev` works from a fresh clone without an extra
// `--env-file` flag. A missing `.env` is not an error here: `config.ts` reports
// the first missing key with a pointer to `.env.example`.
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
