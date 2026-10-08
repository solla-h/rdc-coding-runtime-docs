#!/usr/bin/env node
// One explicitly opted-in, read-only MODEL dogfood; no suite automation,
// persistence, retries, or changes to any Skill installation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildParallelAdvisorPrompt } from "../lib/pi-advisor-decision.mjs";
import { parsePiJsonLines } from "../lib/pi-advisor-fanout.mjs";
import { buildSyntheticTwoShardPlan } from "./fixture-catalog.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const configPath = path.join(home, ".rdc", "how-to-use", "config.json");
const agentDir = path.join(home, ".rdc", "how-to-use", "pi-agent");
if (process.argv.length !== 3 || process.argv[2] !== "--execute-once") {
  console.error("Usage: node runtime/evaluation/run-synthetic-e2e.mjs --execute-once");
  console.error("This makes real model requests: one Pi Main + exactly two disposable Pi Workers.");
  process.exit(2);
}
const plan = buildSyntheticTwoShardPlan();
if (!plan.coverageComplete || plan.shardCount !== 2 || plan.parallelism !== 2) {
  throw new Error("Refusing inconsistent two-shard fixture");
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!cfg.model || !cfg.thinking) throw new Error("Dedicated Pi model settings are missing");
const result = spawnSync("where.exe", ["pi.ps1"], {
  encoding: "utf8", timeout: 3000, windowsHide: true,
});
if (result.status !== 0) throw new Error("pi.ps1 is not resolvable");
const piScript = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
const extension = path.join(root, "synthetic-fanout.ts");
const task = [
  "This is an explicitly isolated synthetic capability catalog acceptance test.",
  "Without calling real systems, recommend a conceptual read-only way to resolve a",
  "Feishu/Lark Base URL to its app token and table ID, then list its records.",
  "The two stages require different capabilities; include both if the fixture supports them.",
  "Do not assert either capability is installed on the real machine.",
  "Do not install, modify local files, contact Lark, or access user data.",
].join(" ");
const prompt = buildParallelAdvisorPrompt(task, path.resolve(root, "../.."));
const argv = [
  "-NoProfile", "-File", piScript,
  "-p", "--mode", "json", "--no-session", "--no-skills",
  "--no-mcp", "--no-extensions", "--extension", extension,
  "--no-context-files", "--no-prompt-templates", "--no-themes",
  "--no-approve", "--tools", "capability_fanout",
  "--provider", "rdc-router", "--model", cfg.model,
  "--thinking", cfg.thinking, prompt,
];
const deadlineMs = Date.now() + 280000;
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_SKIP_VERSION_CHECK: "1",
  RDC_PI_WORKER_SCRIPT: piScript,
  RDC_ADVISOR_WORKER_MODEL: cfg.model,
  RDC_ADVISOR_WORKER_THINKING: cfg.thinking,
  RDC_ADVISOR_DEADLINE_MS: String(deadlineMs),
};
console.error("P3_EVAL_RUNNING owner=rdc-pid main=1 workers=2 fixture_only=true timeout_ms=300000");
const start = performance.now();
const run = spawnSync("pwsh.exe", argv, {
  cwd: path.resolve(root, "../.."),
  env, timeout: 300000, windowsHide: true,
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
});
const elapsedMs = Math.round(performance.now() - start);
const parsed = parsePiJsonLines(run.stdout || "");
const toolEvents = [];
for (const line of (run.stdout || "").split(/\r?\n/)) {
  try {
    const event = JSON.parse(line);
    if (event.type === "tool_execution_end" && event.toolName === "capability_fanout") {
      let payload = event.result?.details ?? null;
      if (!payload) {
        const raw = event.result?.content?.find(part => part.type === "text")?.text;
        if (raw) { try { payload = JSON.parse(raw); } catch { /* not structured */ } }
      }
      toolEvents.push({
        durationMs: event.durationMs ?? null,
        isError: Boolean(event.isError),
        coverage: payload?.coverage ?? null,
        workerUsage: payload?.usage ?? null,
        workerStatus: payload?.results?.map(r => ({
          id: r.id, status: r.status, elapsedMs: r.elapsedMs || null,
          candidateCount: r.candidateCount || 0,
        })) ?? null,
      });
    }
  } catch { /* stdout may contain a non-JSON preamble */ }
}
console.log(JSON.stringify({
  status: run.status === 0 && !parsed.failed && Boolean(parsed.finalText) ?
    "completed" : "failed",
  exitCode: run.status,
  elapsedMs,
  model: parsed.model,
  usage: parsed.usage,
  fanoutCalls: toolEvents.length,
  fanoutToolEvents: toolEvents,
  fixtureShards: plan.shardCount,
  fixtureItems: plan.itemCount,
  answer: parsed.finalText,
  diagnostic: (run.stderr || "").slice(-1600),
}, null, 2));
if (run.status !== 0 || parsed.failed || !parsed.finalText) process.exitCode = 1;
