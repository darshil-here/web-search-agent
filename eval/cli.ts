// eval/cli.ts
//
//   npx tsx eval/cli.ts          offline sweep (free, deterministic)
//   npx tsx eval/cli.ts --live   offline sweep + live answers judged by the model
import { mkdirSync } from "node:fs";
import { CASES } from "./cases.js";
import {
  makeJudge,
  readEnvFile,
  renderReport,
  runLive,
  runOfflineAll,
  writeReport,
} from "./runner.js";

const live = process.argv.includes("--live");

console.log(`Running ${CASES.length} eval cases (${live ? "offline + live" : "offline"})...\n`);

const offline = await runOfflineAll(CASES);
for (const result of offline) {
  console.log(
    `${result.passed ? "PASS" : "FAIL"}  ${result.id.padEnd(20)} ${result.name}` +
      (result.failure ? `\n        ${result.failure}` : "")
  );
}

let liveResults: Awaited<ReturnType<typeof runLive>>[] = [];
if (live) {
  const env = readEnvFile();
  const judge = makeJudge(env);
  console.log("\nLive runs (this calls the model and Tavily)...\n");
  for (const testCase of CASES) {
    if (testCase.live === false) {
      console.log(`SKIP  ${testCase.id.padEnd(20)} pinned clock or offline-only invariant`);
      continue;
    }
    const result = await runLive(testCase, judge, env);
    liveResults.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"}  ${result.id.padEnd(20)} ${result.name}` +
        (result.reasons.length ? `\n        ${result.reasons.join("; ")}` : "")
    );
  }
}

const report = renderReport(offline, liveResults);
mkdirSync("eval/results", { recursive: true });
const path = writeReport(report);
console.log(`\n${report.split("\n").slice(0, 3).join("\n")}`);
console.log(`Report: ${path}`);

const failed = offline.filter((r) => !r.passed).length + liveResults.filter((r) => !r.passed).length;
if (failed > 0) process.exitCode = 1;
