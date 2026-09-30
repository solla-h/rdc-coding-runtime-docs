#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  buildContextSnapshot,
  describeCapability,
  discoverSkillRecords,
  renderContextMarkdown,
} from "./lib/capabilities.mjs";

const HOME = os.homedir();
const ROOT = path.join(HOME, ".rdc", "how-to-use");
const MACHINE_CONTEXT = path.join(HOME, ".rdc", "MACHINE_CONTEXT.md");
const AGENT_DIR = path.join(ROOT, "pi-agent");
const CONFIG_PATH = path.join(ROOT, "config.json");
const MODELS_PATH = path.join(AGENT_DIR, "models.json");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const STATE_PATH = path.join(ROOT, "backend-state.json");
const BOOTSTRAP = path.join(ROOT, "bootstrap-router.mjs");
const PLACEHOLDER = "REPLACE_WITH_";

function readText(p, max = 20000) {
  try { return fs.readFileSync(p, "utf8").slice(0, max); } catch { return ""; }
}
function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function isPlaceholder(v) {
  return typeof v !== "string" || !v || v.includes(PLACEHOLDER);
}
function skillCatalog() {
  return discoverSkillRecords({ home: HOME }).records.map(record => ({
    ...record,
    description: record.summary,
    path: record.details.skillPath,
  }));
}

function findUniqueSkillByName(skills, name) {
  const matches = skills.filter(skill => skill.name.toLowerCase() === String(name).toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}
function configInfo({ syncDerived = false } = {}) {
  const cfg = readJson(CONFIG_PATH);
  if (!cfg) throw new Error("config.json missing; run how-to-use --bootstrap");
  if (!["anthropic-messages", "openai-completions"].includes(cfg.api)) {
    throw new Error("unsupported api: " + cfg.api);
  }
  if (!["off","minimal","low","medium","high","xhigh","max"].includes(cfg.thinking)) {
    throw new Error("unsupported thinking: " + cfg.thinking);
  }
  if (isPlaceholder(cfg.baseUrl)) throw new Error("baseUrl is not configured");
  if (isPlaceholder(cfg.apiKey)) throw new Error("apiKey is not configured");
  if (isPlaceholder(cfg.model)) throw new Error("model is not configured");

  const provider = {
    baseUrl: cfg.baseUrl,
    api: cfg.api,
    apiKey: cfg.apiKey,
    models: [{
      id: cfg.model,
      name: "RDC Router Model",
      reasoning: cfg.thinking !== "off",
      input: ["text"]
    }]
  };
  if (syncDerived) {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    writeJson(MODELS_PATH, { providers: { "rdc-router": provider } });
    writeJson(SETTINGS_PATH, {
      defaultProvider: "rdc-router",
      defaultModel: cfg.model,
      defaultThinkingLevel: cfg.thinking,
      defaultTools: ["read","grep","find","ls"],
      defaultProjectTrust: "never",
      quietStartup: true,
      skills: ["~/.pi/agent/skills"]
    });
  }
  return { provider, model: provider.models[0], thinking: cfg.thinking };
}
function findPiPs1() {
  const r = spawnSync("where.exe", ["pi.ps1"], { encoding:"utf8", windowsHide:true, timeout:3000 });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).map(x => x.trim()).find(Boolean) || null;
}
function piRun(prompt, opts = {}) {
  const pi = findPiPs1();
  if (!pi) return { ok:false, ms:0, output:"", reason:"pi_not_found" };
  const { model, thinking } = configInfo();
  const args = ["-NoProfile", "-File", pi, "-p", "--no-session", "--no-context-files", "--no-approve"];
  if (opts.noTools) args.push("--no-tools"); else args.push("--tools", "read,grep,find,ls");
  if (opts.skillPath) args.push("--no-skills", "--skill", opts.skillPath);
  else if (opts.noSkills) args.push("--no-skills");
  args.push("--provider", "rdc-router", "--model", model.id, "--thinking", thinking, prompt);
  const start = performance.now();
  const run = spawnSync("pwsh.exe", args, {
    encoding:"utf8", windowsHide:true, timeout:opts.timeout || 65000,
    env:{ ...process.env, PI_CODING_AGENT_DIR:AGENT_DIR, PI_SKIP_VERSION_CHECK:"1" }
  });
  const ms = Math.round(performance.now() - start);
  const output = ((run.stdout || "") + "\n" + (run.stderr || "")).trim();
  return {
    ok: run.status === 0 && Boolean(output),
    ms, output,
    reason: run.error?.code === "ETIMEDOUT" || run.signal ? "timeout" : (run.status === 0 ? "ok" : "exit_" + run.status)
  };
}
function extractOpenAI(data) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  return String(msg.content || msg.reasoning_content || choice.text || "").trim();
}
function anthropicUrl(base) {
  const b = base.replace(/\/$/, "");
  if (/\/v1\/messages$/i.test(b)) return b;
  if (/\/v1$/i.test(b)) return b + "/messages";
  return b + "/v1/messages";
}
async function thinLlm(prompt, maxTokens = 1200) {
  const { provider, model } = configInfo();
  let url, headers, body;
  if (provider.api === "anthropic-messages") {
    url = anthropicUrl(provider.baseUrl);
    headers = {
      "content-type":"application/json",
      "x-api-key":provider.apiKey,
      "anthropic-version":"2023-06-01",
      ...(provider.headers || {})
    };
    body = { model:model.id, max_tokens:maxTokens, messages:[{role:"user",content:prompt}] };
  } else {
    url = provider.baseUrl.replace(/\/$/, "") + "/chat/completions";
    headers = {
      "content-type":"application/json",
      "authorization":"Bearer " + provider.apiKey,
      ...(provider.headers || {})
    };
    body = { model:model.id, stream:false, temperature:0, max_tokens:maxTokens, messages:[{role:"user",content:prompt}] };
  }
  const res = await fetch(url, {
    method:"POST", headers, body:JSON.stringify(body), signal:AbortSignal.timeout(45000)
  });
  const raw = await res.text();
  if (!res.ok) throw new Error("thin HTTP " + res.status + ": " + raw.slice(0,300));
  const data = JSON.parse(raw);
  if (provider.api === "anthropic-messages") {
    return (data.content || []).filter(x => x?.type === "text").map(x => x.text).join("\n").trim();
  }
  return extractOpenAI(data);
}
async function verifyConfig() {
  const { provider, model, thinking } = configInfo({ syncDerived: true });
  console.log("config=valid");
  console.log("provider=rdc-router");
  console.log("api=" + provider.api);
  console.log("base_url_configured=yes");
  console.log("api_key_configured=yes");
  console.log("model=" + model.id);
  console.log("thinking=" + thinking);
  console.log("reasoning=" + Boolean(model.reasoning));
  const basic = piRun("Reply with exactly HOW_TO_USE_PI_OK", {
    noTools:true, noSkills:true, timeout:65000
  });
  let preferredBackend = "pi";
  let piUsable = basic.ok && basic.output.includes("HOW_TO_USE_PI_OK");
  let thinUsable = false;
  if (!piUsable) {
    try {
      const t0 = performance.now();
      const reply = await thinLlm("Reply with exactly HOW_TO_USE_THIN_OK", 80);
      thinUsable = reply.includes("HOW_TO_USE_THIN_OK");
      console.log("thin_ms=" + Math.round(performance.now() - t0));
    } catch (e) {
      console.log("thin_error=" + String(e.message || e).slice(0,200));
    }
    preferredBackend = thinUsable ? "thin" : null;
  }
  writeJson(STATE_PATH, {
    version:3, validated:Boolean(preferredBackend), preferredBackend,
    routerProvider:"rdc-router", model:model.id, api:provider.api, thinking,
    piUsable, piMs:basic.ms, piReason:basic.reason, thinUsable
  });
  console.log("pi_usable=" + piUsable);
  console.log("pi_ms=" + basic.ms);
  console.log("preferred_backend=" + (preferredBackend || "none"));
  if (!preferredBackend) process.exitCode = 1;
}
function passLine(name, ok, ms, detail="") {
  console.log(name + "=" + (ok ? "PASS" : "FAIL") + " " + ms + "ms" + (detail ? " " + detail : ""));
}
function benchmark() {
  const state = readJson(STATE_PATH, {});
  if (!state.validated || !state.piUsable) throw new Error("Pi backend is not verified; run --verify-config first");
  const skills = skillCatalog();

  const basic = piRun("Reply with exactly ROUTER_OK", { noTools:true, noSkills:true, timeout:65000 });
  passLine("basic_inference", basic.ok && basic.output.includes("ROUTER_OK"), basic.ms);

  const lark = findUniqueSkillByName(skills, "lark-base");
  if (lark) {
    const route = piRun(
      "Which installed local Skill should be used for Feishu/Lark Base or 多维表格 record operations? Reply with only the exact Skill name.",
      { timeout:65000 }
    );
    passLine("skill_routing", route.ok && /lark-base/i.test(route.output), route.ms);
  } else {
    console.log("skill_routing=SKIP no_lark_base_fixture");
  }

  const schemaPrompt = [
    "You have two tools:",
    "resolve_url(url) -> {app_token, table_id}",
    "list_records(app_token, table_id, page_size) -> records",
    "Goal: read records from a Base URL.",
    "Return only the ordered tool names and the data passed from the first to the second."
  ].join("\n");
  const schema = piRun(schemaPrompt, { noTools:true, noSkills:true, timeout:65000 });
  const text = schema.output.toLowerCase();
  const schemaOk = schema.ok && text.indexOf("resolve_url") >= 0 &&
    text.indexOf("list_records") > text.indexOf("resolve_url") &&
    text.includes("app_token") && text.includes("table_id");
  passLine("schema_reasoning", schemaOk, schema.ms);

  const state2 = { ...state, benchmarkedAt:new Date().toISOString(),
    benchmark:{ basicMs:basic.ms, schemaMs:schema.ms } };
  writeJson(STATE_PATH, state2);
}
function exactCliEvidence(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { name, found:false, reason:"rejected_unsafe_name", resolvedPaths:[] };
  }
  const where = spawnSync("where.exe", [name], {
    encoding:"utf8", windowsHide:true, timeout:3000, shell:false
  });
  const resolvedPaths = where.status === 0
    ? (where.stdout || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    : [];
  return {
    name,
    found: resolvedPaths.length > 0,
    reason: resolvedPaths.length ? "command_resolves" : "not_found_in_path",
    resolvedPaths,
  };
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const unfenced = raw
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "");
  try { return JSON.parse(unfenced); } catch {}
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(unfenced.slice(first, last + 1));
  throw new Error("router did not return valid JSON");
}

function normalizeRoute(raw, snapshot) {
  const knownIds = new Set(snapshot.capabilities.map(item => item.id));
  const requestedIds = Array.isArray(raw?.selectedCapabilityIds) ? raw.selectedCapabilityIds : [];
  const selectedCapabilityIds = [...new Set(
    requestedIds.filter(value => typeof value === "string" && knownIds.has(value))
  )].slice(0, 5);
  const unknownCapabilityIds = [...new Set(
    requestedIds.filter(value => typeof value === "string" && !knownIds.has(value))
  )].slice(0, 5);

  const commandCandidates = [...new Set(
    (Array.isArray(raw?.commandCandidates) ? raw.commandCandidates : [])
      .map(value => String(value || "").trim())
      .filter(value => /^[A-Za-z0-9_.-]+$/.test(value))
  )].slice(0, 8);

  const allowed = new Set(["allowed", "forbidden", "unspecified"]);
  const constraints = {};
  for (const key of ["mutation", "install", "download", "network"]) {
    const value = String(raw?.constraints?.[key] || "unspecified").toLowerCase();
    constraints[key] = allowed.has(value) ? value : "unspecified";
  }

  return {
    selectedCapabilityIds,
    commandCandidates,
    constraints,
    reason: String(raw?.reason || "").slice(0, 1200),
    unknownCapabilityIds,
  };
}

function capabilityCatalogForPrompt(snapshot) {
  return snapshot.capabilities.map(item => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    summary: item.summary,
    source: item.source?.adapter,
    hints: item.hints || undefined,
  }));
}

function routePrompt(task, snapshot) {
  return [
    "You are the semantic router for an RDC local capability runtime.",
    "Use reasoning and semantic understanding. Do not use lexical overlap or keyword-count heuristics.",
    "The capability catalog is evidence-backed but UNRANKED. Select entries only when they are actually relevant to the user's goal and constraints.",
    "Interpret the user's natural-language constraints semantically.",
    "selectedCapabilityIds MUST come from the supplied catalog IDs.",
    "commandCandidates are exact local CLI executable names that should be verified with PATH lookup. They are verification requests, not claims that the command is installed.",
    "If the catalog has no useful capability, selectedCapabilityIds may be empty.",
    "Do not invent an installed capability. Prefer precision over recall.",
    "Return JSON only with this exact shape:",
    '{"selectedCapabilityIds":[],"commandCandidates":[],"constraints":{"mutation":"allowed|forbidden|unspecified","install":"allowed|forbidden|unspecified","download":"allowed|forbidden|unspecified","network":"allowed|forbidden|unspecified"},"reason":"short explanation"}',
    "",
    "TASK:",
    task,
    "",
    "WORKSPACE:",
    snapshot.workspace || "(machine-level)",
    "",
    "MACHINE_HINTS:",
    snapshot.machineHints || "(none)",
    "",
    "PROJECT_EVIDENCE:",
    JSON.stringify(snapshot.projectEvidence),
    "",
    "UNRANKED_CAPABILITY_CATALOG:",
    JSON.stringify(capabilityCatalogForPrompt(snapshot)),
  ].join("\n");
}

function finalPrompt(task, route, evidence, snapshot) {
  return [
    "You advise the primary ChatGPT Web coding agent how to use local capabilities.",
    "Reason semantically from the task, the structured router decision, and verified local evidence.",
    "Treat the structured constraints as hard requirements for the user's target operation.",
    "A command candidate is installed only when exact PATH verification says found=true.",
    "A Skill is available only when its selected capability ID resolves to a real Skill descriptor.",
    "Do not turn package declarations into claims that dependencies are installed.",
    "Do not perform the user's mutation and do not request credentials.",
    "If no currently verified capability fits, say so and describe the smallest targeted verification that the primary agent should perform next.",
    "Return concise Markdown: Recommended capability, Why it fits, How to use/verify, Evidence and limitations.",
    "",
    "TASK:",
    task,
    "",
    "WORKSPACE:",
    snapshot.workspace || "(machine-level)",
    "",
    "ROUTER_DECISION:",
    JSON.stringify(route),
    "",
    "LOCAL_EVIDENCE:",
    evidence.length ? evidence.join("\n\n---\n\n") : "(none)",
  ].join("\n");
}

async function modelCall(backend, prompt, maxTokens = 1200) {
  if (backend === "pi") {
    const run = piRun(prompt, {
      noTools:true,
      noSkills:true,
      timeout:90000,
    });
    if (!run.ok) throw new Error("Pi router failed: " + run.reason);
    return run.output;
  }
  if (backend === "thin") return await thinLlm(prompt, maxTokens);
  throw new Error("unsupported router backend: " + backend);
}

function collectEvidence(route, workspace) {
  const evidence = [];
  for (const id of route.selectedCapabilityIds) {
    const described = describeCapability(id, {
      home: HOME,
      workspace,
      maxSkillContentChars: 18000,
    });
    if (!described.found) {
      evidence.push("Capability " + id + "\n" + JSON.stringify({
        found:false,
        coverage:described.coverage,
      }));
      continue;
    }
    const item = described.capability;
    if (item.kind === "skill") {
      evidence.push(
        "Capability " + item.id + " (" + item.name + ")\n" +
        "SOURCE: " + item.source.location + "\n" +
        "OBSERVATION: " + JSON.stringify(item.observation) + "\n" +
        "SKILL_INSTRUCTIONS:\n" + (item.details.content || "(empty)") +
        (item.details.contentComplete ? "" : "\nFULL_CONTENT_REMAINS_AT: " + item.details.readFullPath)
      );
    } else {
      evidence.push(
        "Capability " + item.id + " (" + item.name + ")\n" +
        JSON.stringify({ source:item.source, observation:item.observation, details:item.details }, null, 2)
      );
    }
  }

  for (const name of route.commandCandidates) {
    evidence.push("Exact CLI verification " + name + "\n" + JSON.stringify(exactCliEvidence(name), null, 2));
  }

  if (route.unknownCapabilityIds.length) {
    evidence.push("Router returned unknown capability IDs that were rejected: " + route.unknownCapabilityIds.join(", "));
  }
  return evidence;
}

async function semanticAdvisor(task, workspace, backend) {
  const snapshot = buildContextSnapshot({
    home: HOME,
    workspace,
    query: task,
    maxItems: 180,
    maxBytes: 64 * 1024,
  });
  const rawRoute = await modelCall(backend, routePrompt(task, snapshot), 900);
  const route = normalizeRoute(parseJsonObject(rawRoute), snapshot);
  const evidence = collectEvidence(route, workspace);
  const reply = await modelCall(backend, finalPrompt(task, route, evidence, snapshot), 1800);
  return { reply, route, snapshot };
}

function runBootstrap(reconfigure=false) {
  const args = [BOOTSTRAP];
  if (reconfigure) args.push("--reconfigure");
  const r = spawnSync(process.execPath, args, {
    encoding:"utf8", windowsHide:true, timeout:10000
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  process.exitCode = r.status ?? 1;
}

function selfCheck() {
  const state = readJson(STATE_PATH, {});
  const skills = skillCatalog();
  console.log("how-to-use=" + (fs.existsSync(MODELS_PATH) ? "installed" : "bootstrap-required"));
  console.log("config_validated=" + Boolean(state.validated));
  console.log("preferred_backend=" + (state.preferredBackend || "none"));
  console.log("pi_version_check=" + Boolean(findPiPs1()));
  console.log("model=" + (state.model || "not-validated"));
  console.log("thinking=" + (state.thinking || "medium"));
  console.log("skills_discovered=" + skills.length);
  console.log("shared_pi_skills=" + fs.existsSync(path.join(HOME,".pi","agent","skills")));
  console.log("shared_agent_skills=" + fs.existsSync(path.join(HOME,".agents","skills")));
}

function parseTaskArgs(args) {
  const rest = [...args];
  let workspace = null;
  let offline = false;
  const workspaceIndex = rest.indexOf("--workspace");
  if (workspaceIndex >= 0) {
    if (workspaceIndex + 1 >= rest.length) throw new Error("--workspace requires a value");
    workspace = path.resolve(rest[workspaceIndex + 1]);
    rest.splice(workspaceIndex, 2);
  }
  const offlineIndex = rest.indexOf("--offline");
  if (offlineIndex >= 0) {
    offline = true;
    rest.splice(offlineIndex, 1);
  }
  return { task:rest.join(" ").trim(), workspace, offline };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--bootstrap")) return runBootstrap(false);
  if (args.includes("--reconfigure")) return runBootstrap(true);
  if (args.includes("--verify-config")) return await verifyConfig();
  if (args.includes("--benchmark")) return benchmark();
  if (args.includes("--self-check")) return selfCheck();

  const parsed = parseTaskArgs(args);
  let task = parsed.task;
  if (!task && !process.stdin.isTTY) task = fs.readFileSync(0,"utf8").trim();
  if (!task) {
    console.error("Usage: how-to-use [--workspace <path>] [--offline] <task> | --bootstrap | --reconfigure | --verify-config | --benchmark | --self-check");
    process.exit(2);
  }

  const requestStart = performance.now();
  if (parsed.offline) {
    const snapshot = buildContextSnapshot({
      home: HOME,
      workspace: parsed.workspace,
      query: task,
      maxItems: 180,
      maxBytes: 64 * 1024,
    });
    console.log(renderContextMarkdown(snapshot, 64 * 1024));
    console.error("[how-to-use] backend=offline-catalog model=none thinking=none" +
      " semantic_selection=false" +
      " elapsed_ms=" + Math.round(performance.now() - requestStart));
    return;
  }

  const state = readJson(STATE_PATH, {});
  if (!state.validated) throw new Error("Router model is not validated; run how-to-use --verify-config");
  const { model, thinking } = configInfo();

  let backend = state.preferredBackend || "thin";
  let result;
  try {
    result = await semanticAdvisor(task, parsed.workspace, backend);
  } catch (error) {
    if (backend !== "pi") throw error;
    backend = "thin";
    result = await semanticAdvisor(task, parsed.workspace, backend);
  }

  console.log(result.reply);
  console.error("[how-to-use] backend=" + backend +
    " model=" + model.id +
    " thinking=" + thinking +
    " selected_capabilities=" + (result.route.selectedCapabilityIds.join(",") || "none") +
    " command_candidates=" + (result.route.commandCandidates.join(",") || "none") +
    " elapsed_ms=" + Math.round(performance.now() - requestStart));
}
main().catch(err => {
  console.error("how-to-use error: " + (err?.message || String(err)));
  process.exit(1);
});