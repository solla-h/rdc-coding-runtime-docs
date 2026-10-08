import { spawn } from "node:child_process";

const VALID_ROLES = new Set(["primary", "supporting", "alternative"]);
const MAX_CANDIDATES = 5;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 8192;

export const DEFAULT_WORKER_TIMEOUT_MS = 120_000;

export function buildWorkerPrompt(task, shard) {
  if (!shard?.id || !Array.isArray(shard.items)) throw new Error("Missing complete shard");
  if (typeof task !== "string" || !task.trim()) throw new Error("Missing task capsule");
  // Use stdin: a 256 KiB prompt cannot reliably be passed as Windows argv.
  return [
    "You are a disposable Pi capability-selection worker.",
    "Read EVERY capability name and FULL description in the assigned shard below.",
    "Choose relevant capabilities using LLM reasoning, not word overlap or string similarity.",
    "Judge actual user success conditions and explicit prohibitions, not just topical relevance.",
    "A Skill that only accesses/displays raw material is not proof it renders/transforms it.",
    "A conditional Skill may be returned as an alternative, but name unmet prerequisites",
    "in the reason rather than treating an unverified dependency as usable.",
    "If no assigned Skill materially helps satisfy the requested outcome, return no candidates.",
    "Do not execute anything. Do not infer that related CLIs are installed or authenticated.",
    "This is only one shard of a larger catalog; lack of a match in this shard does not",
    "mean the user's computer lacks a capability.",
    "Return ONLY a JSON object:",
    '{"candidates":[{"id":"EXACT_ID_FROM_CATALOG","role":"primary|supporting|alternative",',
    '"reason":"Specific fit for this task and any limitations"}],"hasMoreRelevantCandidates":false}',
    "Return 0 to 5 candidates. Use exact IDs only. If none are relevant, return an empty array.",
    "If more than five are relevant, choose the five most useful and set hasMoreRelevantCandidates=true.",
    "Do not invent paths, versions, installed tools, authentication, or evidence.",
    "",
    "TASK CAPSULE:",
    task.trim().slice(0, 8000),
    "",
    "SHARD ID: " + shard.id,
    "COMPLETE ASSIGNED CAPABILITY METADATA:",
    JSON.stringify(shard.items),
  ].join("\n");
}

export function buildPiWorkerInvocation({ piScript, model, thinking, provider = "rdc-router" }) {
  if (typeof piScript !== "string" || !piScript.trim()) throw new Error("Pi launcher path is required");
  if (typeof model !== "string" || !model.trim()) throw new Error("Pi model is required");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
    throw new Error("Invalid Pi thinking level");
  }
  return {
    command: "pwsh.exe",
    args: [
      "-NoProfile", "-File", piScript,
      "--mode", "json", "-p",
      "--no-session", "--no-skills", "--no-mcp", "--no-extensions",
      "--no-context-files", "--no-prompt-templates", "--no-themes",
      "--no-approve", "--no-tools",
      "--provider", provider, "--model", model, "--thinking", thinking,
    ],
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function parsePiJsonLines(output) {
  const usage = emptyUsage();
  let finalText = "";
  let model = null;
  let failed = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    const message = event.message;
    finalText = (message.content || [])
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n");
    model = message.model || model;
    usage.turns += 1;
    const u = message.usage || {};
    usage.input += u.input || 0;
    usage.output += u.output || 0;
    usage.cacheRead += u.cacheRead || 0;
    usage.cacheWrite += u.cacheWrite || 0;
    usage.cost += u.cost?.total || 0;
    if (["error", "aborted"].includes(message.stopReason)) failed = true;
  }
  return { finalText, usage, model, failed };
}

function stopOwnedProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // Only the PID created by this invocation is eligible for tree cleanup.
    try {
      const taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      taskkill.on("error", () => { try { child.kill(); } catch {} });
    } catch { try { child.kill(); } catch {} }
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}

export async function invokePiWorker({
  invocation, prompt, cwd, env = process.env,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, signal = null,
}) {
  if (signal?.aborted) return { ok: false, error: "aborted" };
  if (!invocation?.command || !Array.isArray(invocation.args)) {
    throw new Error("Invalid Pi worker invocation");
  }
  const start = Date.now();
  return new Promise(resolve => {
    let child;
    let completed = false;
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let timer;
    let hardStop;
    let onAbort;
    let terminationRequested = false;
    const finish = code => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      const parsed = parsePiJsonLines(stdout);
      const ok = code === 0 && !spawnError && !overflow && !timedOut && !aborted &&
        !parsed.failed && Boolean(parsed.finalText);
      resolve({
        ok,
        exitCode: code,
        elapsedMs: Date.now() - start,
        output: parsed.finalText,
        usage: parsed.usage,
        model: parsed.model,
        error: aborted ? "aborted" : timedOut ? "timeout" : overflow ? "output_limit" :
          spawnError ? "spawn_error" : parsed.failed ? "model_error" :
          code !== 0 ? "exit_" + code : parsed.finalText ? null : "empty_answer",
        diagnostic: stderr.slice(-MAX_STDERR_BYTES),
      });
    };
    const terminate = reason => {
      if (terminationRequested || completed) return;
      terminationRequested = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "aborted") aborted = true;
      stopOwnedProcess(child);
      hardStop = setTimeout(() => finish(null), 3000);
    };
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd, env, windowsHide: true,
        shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error;
      finish(null);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (completed) return;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_STDOUT_BYTES) {
        overflow = true;
        terminate("output_limit");
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", error => {
      spawnError = error;
    });
    child.on("close", code => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
    timer = setTimeout(() => terminate("timeout"), timeoutMs);
    onAbort = () => terminate("aborted");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseWorkerAnswer(output, shard) {
  let data;
  const trimmed = String(output).trim();
  const fence = String.fromCharCode(96).repeat(3);
  const raw = trimmed.startsWith(fence) ?
    trimmed.slice(fence.length).replace(/^json\s*\n/i, "").replace(/\s*[\x60]{3}$/, "") : trimmed;
  try { data = JSON.parse(raw); }
  catch { throw new Error("invalid_worker_json"); }
  if (!data || !Array.isArray(data.candidates) ||
      typeof data.hasMoreRelevantCandidates !== "boolean" ||
      data.candidates.length > MAX_CANDIDATES) {
    throw new Error("invalid_worker_contract");
  }
  const byId = new Map(shard.items.map(item => [item.id, item]));
  const seen = new Set();
  const candidates = data.candidates.map(candidate => {
    if (typeof candidate?.id !== "string" || !byId.has(candidate.id)) {
      throw new Error("unknown_candidate_id");
    }
    if (seen.has(candidate.id)) throw new Error("duplicate_candidate_id");
    seen.add(candidate.id);
    if (!VALID_ROLES.has(candidate.role) || typeof candidate.reason !== "string" ||
        !candidate.reason.trim() || candidate.reason.length > 1000) {
      throw new Error("invalid_candidate");
    }
    const source = byId.get(candidate.id);
    return {
      id: source.id, name: source.name, description: source.description,
      group: source.group, source: source.source, location: source.location,
      fingerprint: source.fingerprint, role: candidate.role,
      reason: candidate.reason, shardId: shard.id,
    };
  });
  return { candidates, hasMoreRelevantCandidates: data.hasMoreRelevantCandidates };
}

export async function runParallelAdvisor({
  task, shardPlan, invokeWorker, signal = null,
  deadlineMs = Date.now() + 280_000,
  perWorkerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
} = {}) {
  if (!shardPlan?.coverageComplete || !Array.isArray(shardPlan.shards)) {
    throw new Error("Refusing partial or invalid Skill shard plan");
  }
  if (typeof invokeWorker !== "function") throw new Error("Missing worker invocation");
  if (!shardPlan.shards.length) return {
    schema: 1, status: "complete", task, coverage: {
      items: 0, shards: 0, completedShards: 0, missingShards: [],
      allMetadataDelivered: true,
    }, results: [], candidates: [], usage: emptyUsage(),
  };
  const limit = Math.max(1, Math.min(shardPlan.parallelism || 4, 8, shardPlan.shards.length));
  const results = new Array(shardPlan.shards.length);
  let next = 0;
  const started = Date.now();
  const operate = async () => {
    while (true) {
      const index = next++;
      if (index >= shardPlan.shards.length) return;
      const shard = shardPlan.shards[index];
      const timeLeft = deadlineMs - Date.now();
      if (signal?.aborted || timeLeft <= 1000) {
        results[index] = { id: shard.id, status: "failed", count: shard.count,
          error: signal?.aborted ? "aborted" : "deadline_exceeded" };
        continue;
      }
      const timeoutMs = Math.max(1000, Math.min(timeLeft - 500, perWorkerTimeoutMs));
      try {
        const prompt = buildWorkerPrompt(task, shard);
        const answer = await invokeWorker({ shard, prompt, timeoutMs, signal });
        if (!answer.ok) throw new Error(answer.error || "worker_failed");
        const selected = parseWorkerAnswer(answer.output, shard);
        results[index] = { id: shard.id, status: "complete", count: shard.count,
          candidates: selected.candidates,
          hasMoreRelevantCandidates: selected.hasMoreRelevantCandidates,
          elapsedMs: answer.elapsedMs || 0, usage: answer.usage || emptyUsage(),
          model: answer.model || null, oversized: Boolean(shard.oversized) };
      } catch (error) {
        results[index] = { id: shard.id, status: "failed", count: shard.count,
          error: error.message?.slice(0, 100) || "worker_failed" };
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, operate));
  const completed = results.filter(result => result.status === "complete");
  const missing = results.filter(result => result.status !== "complete").map(result => result.id);
  const usage = emptyUsage();
  for (const entry of completed) for (const k of Object.keys(usage)) {
    usage[k] += Number(entry.usage[k] || 0);
  }
  return {
    schema: 1,
    status: missing.length ? (completed.length ? "incomplete" : "failed") : "complete",
    task, elapsedMs: Date.now() - started,
    coverage: {
      items: shardPlan.itemCount, shards: shardPlan.shards.length,
      completedShards: completed.length, missingShards: missing,
      deliveredItems: completed.reduce((sum, value) => sum + value.count, 0),
      allMetadataDelivered: missing.length === 0,
      inputDigest: shardPlan.inputDigest,
    },
    results: results.map(({ candidates, ...result }) => ({
      ...result, candidateCount: candidates?.length || 0,
    })),
    candidates: completed.flatMap(result => result.candidates), usage,
    moreCandidatesOmitted: completed.some(result => result.hasMoreRelevantCandidates),
  };
}
