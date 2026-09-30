#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  buildContextSnapshot,
  discoverSkillRecords,
  renderContextMarkdown,
} from "./lib/capabilities.mjs";

const HOME = os.homedir();
const ROOT = path.join(HOME, ".rdc", "how-to-use");
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(ROOT, "pi-agent");
const CONFIG_PATH = path.join(ROOT, "config.json");
const MODELS_PATH = path.join(AGENT_DIR, "models.json");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const STATE_PATH = path.join(ROOT, "backend-state.json");
const BOOTSTRAP = path.join(ROOT, "bootstrap-router.mjs");
const ADVISOR_EXTENSION = path.join(RUNTIME_DIR, "pi-capability-tools.ts");
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
  if (opts.noTools) {
    args.push("--no-tools");
  } else if (opts.advisorTools) {
    args.push("--extension", ADVISOR_EXTENSION);
    args.push("--tools", "read,grep,find,ls,capability_context,capability_describe,command_resolve");
  } else {
    args.push("--tools", "read,grep,find,ls");
  }
  if (opts.noSkills) args.push("--no-skills");
  args.push("--provider", "rdc-router", "--model", model.id, "--thinking", thinking, prompt);
  const workspace = opts.workspace ? path.resolve(opts.workspace) : process.cwd();
  const start = performance.now();
  const run = spawnSync("pwsh.exe", args, {
    encoding:"utf8", windowsHide:true, timeout:opts.timeout || 65000, cwd:workspace,
    env:{
      ...process.env,
      PI_CODING_AGENT_DIR:AGENT_DIR,
      PI_SKIP_VERSION_CHECK:"1",
      RDC_ADVISOR_WORKSPACE:workspace,
    }
  });
  const ms = Math.round(performance.now() - start);
  const output = ((run.stdout || "") + "\n" + (run.stderr || "")).trim();
  return {
    ok: run.status === 0 && Boolean(output),
    ms, output,
    reason: run.error?.code === "ETIMEDOUT" || run.signal ? "timeout" : (run.status === 0 ? "ok" : "exit_" + run.status)
  };
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
  const piUsable = basic.ok && basic.output.includes("HOW_TO_USE_PI_OK");
  writeJson(STATE_PATH, {
    version:3,
    validated:piUsable,
    preferredBackend:piUsable ? "pi" : null,
    routerProvider:"rdc-router",
    model:model.id,
    api:provider.api,
    thinking,
    piUsable,
    piMs:basic.ms,
    piReason:basic.reason
  });
  console.log("pi_usable=" + piUsable);
  console.log("pi_ms=" + basic.ms);
  console.log("preferred_backend=" + (piUsable ? "pi" : "none"));
  if (!piUsable) process.exitCode = 1;
}function passLine(name, ok, ms, detail="") {
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
function advisorPrompt(task, workspace) {
  return [
    "Task capsule from the primary ChatGPT Web agent:",
    task,
    "",
    "Act as a read-only local capability advisor. Run one native Pi agent loop until you have enough evidence to answer.",
    "Use installed Skill descriptions for semantic selection and load full Skill instructions only when relevant.",
    "Use read/grep/find/ls for project evidence. Use capability_context for the bounded unranked RDC catalog, capability_describe for one exact stable capability ID, and command_resolve for one exact CLI name.",
    "Do not implement lexical or regex routing. Do not guess that a command is installed. Do not install, download, mutate files, or call external business systems.",
    "Do not promote an adjacent capability as the recommendation merely because it is available. Preserve the user's success criteria: for example, serving raw files is not the same capability as rendering/previewing them. If no verified local capability fully fits, say so and identify the smallest remaining verification.",
    "The primary ChatGPT Web agent owns all effectful execution through RDC.",
    "Return concise Markdown with: Recommended capability/path, evidence, exact verification if still needed, and limitations.",
    "",
    "WORKSPACE:",
    workspace || "(machine-level)"
  ].join("\n");
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
  if (!state.validated || !state.piUsable) {
    throw new Error("Pi backend is not verified; run how-to-use --verify-config");
  }
  const { model, thinking } = configInfo();
  const workspace = parsed.workspace || process.cwd();
  const run = piRun(advisorPrompt(task, workspace), {
    workspace,
    advisorTools:true,
    timeout:90000,
  });
  if (!run.ok) throw new Error("Pi advisor failed: " + run.reason);

  console.log(run.output);
  console.error("[how-to-use] backend=pi" +
    " model=" + model.id +
    " thinking=" + thinking +
    " agent_loop=native" +
    " elapsed_ms=" + Math.round(performance.now() - requestStart));
}
main().catch(err => {
  console.error("how-to-use error: " + (err?.message || String(err)));
  process.exit(1);
});