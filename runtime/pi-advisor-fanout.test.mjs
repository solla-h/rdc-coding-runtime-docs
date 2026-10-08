import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  buildWorkerPrompt, buildPiWorkerInvocation, parsePiJsonLines,
  invokePiWorker, runParallelAdvisor,
} from "./lib/pi-advisor-fanout.mjs";
import { shardCapabilities } from "./lib/capability-shards.mjs";
import { buildParallelAdvisorPrompt } from "./lib/pi-advisor-decision.mjs";

function catalog(count, descriptionLength = 500) {
  return Array.from({ length: count }, (_, i) => ({
    id: "skill:hub:example-" + String(i).padStart(5, "0"),
    name: "example-" + i,
    description: "Purpose " + i + " " + "a".repeat(descriptionLength),
    group: "skill:example-" + i,
    source: "fixture",
    location: "C:/fixtures/example-" + i + "/SKILL.md",
    fingerprint: "sha-" + i,
  }));
}

function answer(selected = [], extras = {}) {
  return {
    ok: true, output: JSON.stringify({ candidates: selected, hasMoreRelevantCandidates: false, ...extras }),
    usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, cost: 0.001, turns: 1 },
    model: "fake-model", elapsedMs: 5,
  };
}

test("worker prompt includes all complete descriptions from its shard", () => {
  const p = shardCapabilities(catalog(3, 4000), { targetBytes: 30000, parallelism: 2 });
  const prompt = buildWorkerPrompt("preview an ebook", p.shards[0]);
  assert.equal(p.shardCount, 1);
  for (const item of p.shards[0].items) {
    assert.ok(prompt.includes(item.id));
    assert.ok(prompt.includes(item.description));
  }
  assert.match(prompt, /return an empty array/i);
  assert.ok(!prompt.includes("substring scoring"));
});

test("worker invocation is isolated and its large prompt is passed via stdin", () => {
  const invoke = buildPiWorkerInvocation({
    piScript: "C:/Program Files/npm/pi.ps1", model: "sonnet-test", thinking: "high",
  });
  const args = invoke.args.join(" ");
  assert.equal(invoke.command, "pwsh.exe");
  for (const flag of ["--no-session", "--no-skills", "--no-extensions", "--no-mcp",
    "--no-context-files", "--no-tools", "--no-approve", "--mode json"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.includes("SKILL.md"));
});

test("JSON event parser keeps last assistant answer and usage counters", () => {
  const event = { type: "message_end", message: {
    role: "assistant", model: "sonnet-test", content: [{ type: "text", text: '{"candidates":[],"hasMoreRelevantCandidates":false}' }],
    usage: { input: 123, output: 44, cacheRead: 15, cacheWrite: 2, cost: { total: 0.002 } },
  } };
  const parsed = parsePiJsonLines(JSON.stringify({ type: "session_start" }) +
    "\n" + JSON.stringify(event) + "\n");
  assert.equal(parsed.usage.input, 123);
  assert.equal(parsed.usage.output, 44);
  assert.equal(parsed.usage.cost, 0.002);
  assert.equal(parsed.model, "sonnet-test");
  assert.match(parsed.finalText, /candidates/);
});

test("actual spawned Node subprocess receives > 32KB prompt on stdin", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-pi-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-pi.cjs");
  fs.writeFileSync(file, [
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", x => { data += x });',
    'process.stdin.on("end", () => {',
    ' const output = { candidates: [], hasMoreRelevantCandidates: false };',
    ' const event = {type:"message_end", message:{role:"assistant",',
    ' content:[{type:"text", text: JSON.stringify(output)}],',
    ' usage:{input:data.length,output:4,cost:{total:0.003}}}};',
    ' console.log(JSON.stringify(event));',
    '});',
  ].join("\n"));
  const prompt = "long document ".repeat(21000);
  const result = await invokePiWorker({
    invocation: { command: process.execPath, args: [file] },
    prompt, cwd: dir, timeoutMs: 4000,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.usage.input, prompt.length);
  assert.match(result.output, /candidates/);
});

test("fanout respects parallelism, preserves deterministic output order, and total coverage", async () => {
  const p = shardCapabilities(catalog(320, 1300), { targetBytes: 65536, parallelism: 4 });
  assert.ok(p.shardCount > 4);
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const result = await runParallelAdvisor({
    task: "Find a documentation preview capability", shardPlan: p,
    invokeWorker: async ({ shard, prompt }) => {
      active++;
      maxActive = Math.max(active, maxActive);
      assert.equal(prompt.includes(shard.items[0].description), true);
      await new Promise(resolve => setTimeout(resolve, shard.id.endsWith("0001") ? 30 : 5));
      active--;
      completed++;
      return answer([{ id: shard.items[0].id, role: "primary", reason: "Applicable description." }]);
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.coverage.allMetadataDelivered, true);
  assert.equal(result.coverage.deliveredItems, 320);
  assert.equal(result.coverage.missingShards.length, 0);
  assert.equal(completed, p.shardCount);
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= 4);
  assert.deepEqual(result.candidates.map(x => x.shardId), p.shards.map(x => x.id));
  assert.equal(result.usage.input, 10 * p.shardCount);
  assert.ok(result.candidates.every(x => x.description.length > 1300));
});

test("a failed shard never becomes no-match; unknown IDs are rejected", async () => {
  const p = shardCapabilities(catalog(10, 600), { targetBytes: 1600, parallelism: 2 });
  const result = await runParallelAdvisor({
    task: "Find tool", shardPlan: p,
    invokeWorker: async ({ shard }) => shard.id === "shard-0002" ?
      answer([{ id: "skill:hub:invented", role: "primary", reason: "Hallucinated." }]) :
      answer([]),
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.coverage.missingShards, ["shard-0002"]);
  assert.equal(result.coverage.allMetadataDelivered, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.results.find(x => x.id === "shard-0002").error, "unknown_candidate_id");
});

test("invalid worker output, duplicate IDs, and oversized candidate lists fail closed", async () => {
  const p = shardCapabilities(catalog(6, 300), { targetBytes: 6000, parallelism: 1 });
  const id = p.shards[0].items[0].id;
  for (const worker of [
    async () => ({ ok: true, output: "not-json" }),
    async () => answer([{ id, role: "primary", reason: "Fit" }, { id, role: "primary", reason: "Again" }]),
    async () => answer(Array.from({ length: 6 }, () => ({ id, role: "primary", reason: "Spam" }))),
    async () => ({ ok: false, error: "timeout" }),
  ]) {
    const result = await runParallelAdvisor({ task: "test", shardPlan: p, invokeWorker: worker });
    assert.equal(result.status, "failed");
    assert.equal(result.coverage.completedShards, 0);
  }
});

test("deadline aborts queued shards and marks them incomplete", async () => {
  const p = shardCapabilities(catalog(100, 800), { targetBytes: 2000, parallelism: 2 });
  const result = await runParallelAdvisor({
    task: "test", shardPlan: p, deadlineMs: Date.now() + 1020,
    invokeWorker: async () => { await new Promise(resolve => setTimeout(resolve, 1050)); return answer([]); },
  });
  assert.equal(result.status, "incomplete");
  assert.ok(result.coverage.missingShards.length > 0);
});

test("no matches across all shards yields complete with empty shortlist", async () => {
  const p = shardCapabilities(catalog(45, 700), { targetBytes: 3000, parallelism: 4 });
  const result = await runParallelAdvisor({
    task: "not in catalog", shardPlan: p, invokeWorker: async () => answer([]),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverage.allMetadataDelivered, true);
});


test("experimental launcher opts into fanout without changing single-Pi default", () => {
  const source = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "how-to-use.mjs"),
    "utf8",
  );
  assert.match(source, /--parallel-advisor/);
  assert.match(source, /parallelAdvisor:parsed.parallelAdvisor/);
  assert.match(source, /noSkills:parsed.parallelAdvisor/);
  assert.match(source, /--no-extensions/);
  assert.match(source, /FANOUT_EXTENSION/);
  assert.match(source, /capability_fanout/);
  assert.match(source, /RDC_ADVISOR_DEADLINE_MS/);
  assert.match(source, /const ADVISOR_TIMEOUT_MS = 300000/);
});


test("timed-out local worker process is settled without a blind retry", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-pi-timeout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hung-worker.cjs");
  fs.writeFileSync(file, 'process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => {}, 15000));');
  const result = await invokePiWorker({
    invocation: { command: process.execPath, args: [file] },
    prompt: "metadata", cwd: dir, timeoutMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
  assert.ok(result.elapsedMs < 5000);
});

test("an aborted worker is not retried and is explicitly incomplete", async () => {
  const p = shardCapabilities(catalog(5, 300), { targetBytes: 1024, parallelism: 1 });
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runParallelAdvisor({
    task: "no model calls permitted", shardPlan: p, signal: controller.signal,
    invokeWorker: async () => { calls++; return answer([]); },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.coverage.missingShards.length, p.shardCount);
  assert.ok(result.results.every(x => x.error === "aborted"));
});


test("Main treats Skill shortlist as conditional evidence and evaluates native no-Skill solutions", () => {
  const examples = [
    "Preview a book chapter without installing software or running servers",
    "Inspect an existing local CSV without adding any packages",
    "Recommend how to examine an already configured internal Base, without executing it",
  ];
  for (const task of examples) {
    const prompt = buildParallelAdvisorPrompt(task, "C:/work");
    assert.ok(prompt.includes(task));
    assert.match(prompt, /call capability_fanout exactly once/i);
    assert.match(prompt, /no Skill/i);
    assert.match(prompt, /success condition/i);
    assert.match(prompt, /command_resolve/);
    assert.match(prompt, /does NOT mean all installed local programs/i);
    assert.match(prompt, /verification|verified/i);
    assert.match(prompt, /shard failed/i);
    assert.match(prompt, /user's hard constraints/i);
    assert.match(prompt, /primary ChatGPT owns effectful execution/i);
  }
  assert.throws(() => buildParallelAdvisorPrompt("  "), /nonempty/i);
});

test("Worker relevance is not treated as proof of runtime readiness", () => {
  const p = shardCapabilities(catalog(2, 800), { targetBytes: 16000, parallelism: 1 });
  const prompt = buildWorkerPrompt(
    "Find a way to preview local Markdown without a browser extension", p.shards[0],
  );
  assert.match(prompt, /actual user success conditions/i);
  assert.match(prompt, /unverified dependency/i);
  assert.match(prompt, /no candidates/i);
  assert.ok(!prompt.includes("Use lexical matching"));
});

test("source launcher keeps opt-in parallel isolation and existing single-Pi mode", () => {
  const source = fs.readFileSync(
    new URL("./how-to-use.mjs", import.meta.url), "utf8",
  );
  assert.match(source, /--parallel-advisor/);
  assert.match(source, /buildParallelAdvisorPrompt/);
  assert.match(source, /args\.push\("--no-mcp", "--no-extensions"\)/);
  assert.match(source, /advisorTools:true/);
  assert.match(source, /noSkills:parsed\.parallelAdvisor/);
  assert.match(source, /ADVISOR_TIMEOUT_MS = 300000/);
});
