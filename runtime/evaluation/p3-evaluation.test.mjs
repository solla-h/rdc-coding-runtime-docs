import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSyntheticTwoShardPlan } from "./fixture-catalog.mjs";
import { buildParallelAdvisorPrompt } from "../lib/pi-advisor-decision.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(root, "run-synthetic-e2e.mjs");

test("cross-shard fixture requires two different conceptual skills", () => {
  const p = buildSyntheticTwoShardPlan();
  assert.equal(p.schema, 1);
  assert.equal(p.parallelism, 2);
  assert.equal(p.coverageComplete, true);
  assert.equal(p.itemCount, 4);
  assert.equal(p.shardCount, 2);
  assert.deepEqual(p.shards.map(x => x.count), [2, 2]);
  const group = p.shards.map(x => x.items.map(y => y.name));
  assert.ok(group[0].includes("a-base-url"));
  assert.ok(group[1].includes("c-base-records"));
  assert.equal(p.shards.every(x => x.bytes <= 1100), true);
  assert.deepEqual(p.oversizedShards, []);
});

test("each fixture candidate has a full description but no real filesystem location", () => {
  const p = buildSyntheticTwoShardPlan();
  const all = p.shards.flatMap(group => group.items);
  assert.equal(new Set(all.map(x => x.id)).size, 4);
  assert.ok(all.every(item => item.source === "isolated-test-fixture"));
  assert.ok(all.every(item => item.location.startsWith("fixture://")));
  assert.ok(all.every(item => item.description.length > 100));
  const text = buildParallelAdvisorPrompt(
    "Recommend, do not execute, a Feishu Base URL resolve followed by record listing", "C:/fake",
  );
  assert.match(text, /call capability_fanout exactly once/i);
  assert.match(text, /unverified/i);
});

test("the model-driven runner requires one explicit expensive invocation", () => {
  const result = spawnSync(process.execPath, [runner], {
    encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--execute-once/);
  assert.match(result.stderr, /real model requests/);
  assert.ok(!result.stdout);
});

test("real Pi test adapter reuses production fanout and isolates the fixture", () => {
  const ext = fs.readFileSync(path.join(root, "synthetic-fanout.ts"), "utf8");
  const runnerCode = fs.readFileSync(runner, "utf8");
  assert.match(ext, /buildSyntheticTwoShardPlan/);
  assert.match(ext, /runParallelAdvisor/);
  assert.match(ext, /invokePiWorker/);
  assert.match(ext, /status: "failed"/);
  assert.doesNotMatch(ext, /planSkillHub|syncSkillHub|fetch\(/);
  for (const flag of ["--no-skills", "--no-mcp", "--no-extensions", "--no-session",
    "--no-context-files"]) assert.ok(runnerCode.includes(flag), flag);
  assert.match(runnerCode, /--execute-once/);
  assert.match(runnerCode, /parsePiJsonLines/);
});
