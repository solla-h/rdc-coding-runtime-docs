#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  buildContextSnapshot,
  discoverSkillRecords,
  likelySkills,
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
function safeCliHelp(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return "Rejected unsafe CLI name.";
  const where = spawnSync("where.exe", [name], { encoding:"utf8", windowsHide:true, timeout:3000 });
  if (where.status !== 0) return "CLI not found in PATH.";
  const run = spawnSync(name, ["--help"], { encoding:"utf8", windowsHide:true, timeout:7000, shell:false });
  return ("PATH:\n" + (where.stdout || "").trim() + "\n\nHELP:\n" +
    ((run.stdout || "") + "\n" + (run.stderr || "")).trim()).slice(0,14000);
}
function skillRequiredCli(skill) {
  if (skill.details?.bins?.length) return skill.details.bins[0];
  const text = readText(skill.path, 6000);
  return text.match(/bins:\s*\[\s*["']?([A-Za-z0-9_.-]+)/i)?.[1] || null;
}
function parseRoute(text) {
  const cli = text.match(/^CLI:\s*(.+)$/mi)?.[1]?.trim() || "none";
  const raw = text.match(/^SKILLS?:\s*(.+)$/mi)?.[1]?.trim() || "none";
  const skills = raw.toLowerCase() === "none" ? [] :
    raw.split(",").map(s => s.trim()).filter(Boolean).slice(0,3);
  return { cli:cli.toLowerCase() === "none" ? null : cli, skills };
}
function routePrompt(task, context, skills) {
  return [
    "You are a local capability router. Use only the local evidence below.",
    "Treat task constraints such as read-only, no install, no download, no network, and no mutation as hard requirements.",
    "Choose at most one CLI and three Skills. Do not invent capabilities.",
    "If multiple Skill entries share one display name, do not choose that name without disambiguating evidence.",
    "Prefer stable user-level capabilities over private dependencies embedded inside another application's package tree.",
    "Return exactly: CLI, SKILLS, WHY.",
    "", "TASK:", task, "", "MACHINE_CONTEXT:", context || "(missing)", "",
    "LOCAL_SKILLS:", skills.map(s => "- " + s.name + " [" + s.id + "]: " + s.description).join("\n")
  ].join("\n");
}
function finalPrompt(task, route, evidence) {
  return [
    "You advise the primary ChatGPT Web agent how to use local capabilities.",
    "Ground the answer in LOCAL EVIDENCE. Preserve multi-tool reasoning when needed.",
    "Treat every task constraint as hard: read-only, no install, no network, no mutation, or similar constraints must be obeyed.",
    "If a useful option would require a prohibited install/download/network action, label it only as a future option, not as currently usable.",
    "Prefer stable user-level capabilities: PATH CLIs, explicitly configured services, canonical Skills, and documented local tools.",
    "Do not treat another application's private node_modules/internal dependency as a normal installed capability. If mentioned at all, label it incidental and unstable.",
    "Do not perform mutations and do not request credentials.",
    "Return concise Markdown: Recommended capability, How, Verify first, Local evidence.",
    "", "TASK:", task, "", "ROUTER:", route, "", "LOCAL EVIDENCE:",
    evidence.join("\n\n---\n\n") || "(none)"
  ].join("\n");
}
async function thinAdvisor(task, context, skills, autoSkills) {
  let routeText, picked;
  if (autoSkills.length) {
    const cli = skillRequiredCli(autoSkills[0]);
    routeText = "CLI: " + (cli || "none") + "\nSKILLS: " + autoSkills[0].name +
      "\nWHY: high-confidence local Skill match";
    picked = { cli, skills:[autoSkills[0].name] };
  } else {
    routeText = await thinLlm(routePrompt(task, context, skills), 420);
    picked = parseRoute(routeText);
  }
  const evidence = [];
  if (picked.cli) evidence.push("CLI " + picked.cli + "\n" + safeCliHelp(picked.cli));
  for (const name of picked.skills) {
    const found = findUniqueSkillByName(skills, name);
    if (found) {
      evidence.push("Skill " + name + " at " + found.path + "\n" + readText(found.path,18000));
    } else if (skills.some(skill => skill.name.toLowerCase() === name.toLowerCase())) {
      evidence.push("Skill " + name + " is ambiguous across multiple local sources; use rdc-cap find/describe to disambiguate.");
    }
  }
  return await thinLlm(finalPrompt(task, routeText, evidence), 1600);
}
function piAdvisor(task, autoSkills) {
  let prompt = [
    "Task capsule from the primary ChatGPT Web agent:",
    task, "",
    "Determine the best local capability and explain how the primary agent should use it.",
    "Treat all constraints in the task capsule as hard requirements.",
    "If the task says no install/download/network/mutation, do not recommend a path that requires that action as currently usable.",
    "Prefer stable user-level capabilities: PATH CLIs, configured services, canonical Skills, and documented local tools.",
    "Do not promote private dependencies found inside another application's node_modules or internal package tree to normal installed capabilities.",
    "Do not infer that tool B is installed merely because tool A often depends on or integrates with it. Distinguish verified, inferred, and future capabilities; only call something installed when local evidence verifies it.",
    "Use local Skills and evidence. Do not perform the user's mutation."
  ].join("\n");
  const opts = { timeout:90000 };
  if (autoSkills.length) {
    opts.skillPath = path.dirname(autoSkills[0].path);
    prompt += "\n\nA high-confidence Skill match is " + autoSkills[0].name +
      ". Read that Skill and use it.";
  }
  const run = piRun(prompt, opts);
  return run.ok ? run.output : null;
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

function requiresDeterministicDiscovery(task) {
  const text = String(task || "");
  const lower = text.toLowerCase();
  return /\b(read[- ]?only|readonly|no[- ]?network|offline|no[- ]?mutation|do not modify|don't modify|without modifying)\b/.test(lower) ||
    /(只读|不要修改|禁止修改|不得修改|不要联网|禁止联网|不得联网|不联网|离线)/.test(text);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--bootstrap")) return runBootstrap(false);
  if (args.includes("--reconfigure")) return runBootstrap(true);
  if (args.includes("--verify-config")) return await verifyConfig();
  if (args.includes("--benchmark")) return benchmark();
  if (args.includes("--self-check")) return selfCheck();

  let task = args.join(" ").trim();
  if (!task && !process.stdin.isTTY) task = fs.readFileSync(0,"utf8").trim();
  if (!task) {
    console.error("Usage: how-to-use <task> | --bootstrap | --reconfigure | --verify-config | --benchmark | --self-check");
    process.exit(2);
  }

  const requestStart = performance.now();
  if (requiresDeterministicDiscovery(task)) {
    const snapshot = buildContextSnapshot({ home: HOME, query: task });
    console.log(renderContextMarkdown(snapshot));
    console.error("[how-to-use] backend=deterministic model=none thinking=none" +
      " preselected_skill=none" +
      " elapsed_ms=" + Math.round(performance.now() - requestStart));
    return;
  }

  const state = readJson(STATE_PATH, {});
  if (!state.validated) throw new Error("Router model is not validated; run how-to-use --verify-config");
  const context = readText(MACHINE_CONTEXT, 12000);
  const skills = skillCatalog();
  const autoSkills = likelySkills(task, skills);
  const { model, thinking } = configInfo();
  const selectedSkill = autoSkills[0]?.name || "none";

  if (state.preferredBackend === "pi") {
    const reply = piAdvisor(task, autoSkills);
    if (reply) {
      console.log(reply);
      console.error("[how-to-use] backend=pi model=" + model.id +
        " thinking=" + thinking +
        " preselected_skill=" + selectedSkill +
        " elapsed_ms=" + Math.round(performance.now() - requestStart));
      return;
    }
  }

  const thinReply = await thinAdvisor(task, context, skills, autoSkills);
  console.log(thinReply);
  console.error("[how-to-use] backend=thin model=" + model.id +
    " thinking=" + thinking +
    " preselected_skill=" + selectedSkill +
    " elapsed_ms=" + Math.round(performance.now() - requestStart));
}

main().catch(err => {
  console.error("how-to-use error: " + (err?.message || String(err)));
  process.exit(1);
});