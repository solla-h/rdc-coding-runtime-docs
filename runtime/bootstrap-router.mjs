import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const home = os.homedir();
const root = path.join(home, ".rdc", "how-to-use");
const agentDir = path.join(root, "pi-agent");
const configPath = path.join(root, "config.json");
const modelsPath = path.join(agentDir, "models.json");
const settingsPath = path.join(agentDir, "settings.json");
const statePath = path.join(root, "backend-state.json");
const reconfigure = process.argv.includes("--reconfigure");

fs.mkdirSync(agentDir, { recursive: true });

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function configured(v) {
  return typeof v === "string" && v.length > 0 && !v.includes("REPLACE_WITH_");
}
function migrateExistingModels() {
  const old = readJson(modelsPath);
  const p = old?.providers?.["rdc-router"];
  const m = p?.models?.[0];
  if (!p || !m || !configured(p.baseUrl) || !configured(p.apiKey) || !configured(m.id)) return null;
  const oldSettings = readJson(settingsPath) || {};
  return {
    api: p.api || "anthropic-messages",
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: m.id,
    thinking: oldSettings.defaultThinkingLevel || "medium"
  };
}

const template = {
  api: "anthropic-messages",
  baseUrl: "REPLACE_WITH_API_BASE_URL",
  apiKey: "REPLACE_WITH_YOUR_API_KEY",
  model: "REPLACE_WITH_MODEL_ID",
  thinking: "medium"
};

let created = false;
let migrated = false;
if (!fs.existsSync(configPath)) {
  const prior = migrateExistingModels();
  writeJson(configPath, prior || template);
  created = true;
  migrated = Boolean(prior);
}
const cfg = readJson(configPath) || template;
const validApi = ["anthropic-messages", "openai-completions"].includes(cfg.api);
const validThinking = ["off","minimal","low","medium","high","xhigh","max"].includes(cfg.thinking);
const complete = validApi && validThinking &&
  configured(cfg.baseUrl) && configured(cfg.apiKey) && configured(cfg.model);

if (complete) {
  writeJson(modelsPath, {
    providers: {
      "rdc-router": {
        baseUrl: cfg.baseUrl,
        api: cfg.api,
        apiKey: cfg.apiKey,
        models: [{
          id: cfg.model,
          name: "RDC Router Model",
          reasoning: cfg.thinking !== "off",
          input: ["text"]
        }]
      }
    }
  });
}
writeJson(settingsPath, {
  defaultProvider: "rdc-router",
  defaultModel: complete ? cfg.model : undefined,
  defaultThinkingLevel: validThinking ? cfg.thinking : "medium",
  defaultTools: ["read", "grep", "find", "ls"],
  defaultProjectTrust: "never",
  quietStartup: true,
  skills: ["~/.pi/agent/skills"]
});

fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), `# RDC Local Capability Advisor

Act as a read-only local capability advisor for the primary ChatGPT Web agent.

- Prefer local evidence and installed Skills over model memory.
- Perform semantic reasoning yourself. Capability catalogs are unranked evidence; do not treat lexical overlap, keyword frequency, or name similarity as proof of relevance.
- Interpret task constraints semantically. If the task says read-only, no install, no download, no network, or no mutation (including equivalent wording), treat that as a hard requirement for the user's target operation.
- Stable capability IDs identify evidence-backed local entries. Select by ID when IDs are provided; do not silently collapse same-name Skills.
- CLI names proposed by the model are verification candidates, not claims of installation. Exact PATH evidence must confirm them.
- If a useful option requires a prohibited action, mention it only as a future option, not as currently usable.
- Prefer stable user-level capabilities: PATH CLIs, explicitly configured services, canonical Skills, and documented local tools.
- Do not promote another application's private node_modules/internal dependency to a normal installed capability. If it is relevant, label it incidental and unstable.
- Do not infer that one tool is installed merely because another tool usually depends on or integrates with it. Distinguish verified, inferred, and future capabilities.
- Use Skills lazily and preserve multi-tool reasoning when needed.
- User Pi Skills from ~/.pi/agent/skills are shared through settings.json.
- ~/.agents/skills remains a Pi-native shared Skill source.
- Use only read/grep/find/ls. Do not mutate repositories or external systems.
- Never request or expose credentials.
`, "utf8");

fs.writeFileSync(path.join(agentDir, "README.md"), `# Generated RDC Router Pi Runtime

This directory is generated and maintained by the RDC \`how-to-use\` runtime.

## User configuration

Edit this file instead:

\`\`\`text
..\\config.json
\`\`\`

That is the single user-facing configuration source for API protocol, Base URL,
API key, model ID, and thinking level.

## Generated files

Do not edit these files directly unless you are debugging the runtime:

- \`models.json\` — generated Pi provider/model adapter derived from \`..\\config.json\`.
- \`settings.json\` — generated Pi runtime settings, including thinking level and shared Skill sources.
- \`APPEND_SYSTEM.md\` — generated read-only capability-advisor system instructions.
- \`auth.json\` — Pi's isolated auth store. It may be \`{}\` when the custom router provider uses the API key from \`models.json\`.
- \`models-store.json\` and backup files — Pi/runtime internal state or migration artifacts.

Changes made directly to generated files may be overwritten when configuration is synchronized.

## Common commands

\`\`\`text
how-to-use --reconfigure
how-to-use --verify-config
how-to-use --benchmark
how-to-use --self-check
\`\`\`

Effective configuration flow:

\`\`\`text
..\\config.json
    -> models.json + settings.json
    -> dedicated Pi runtime
\`\`\`
`, "utf8");

writeJson(statePath, {
  version: 3,
  validated: false,
  preferredBackend: null,
  configPath
});

console.log("bootstrap=ok");
console.log("config_path=" + configPath);
console.log("config_created=" + created);
console.log("migrated_from_models=" + migrated);
console.log("config_complete=" + complete);
console.log("supported_api=anthropic-messages|openai-completions");
console.log("supported_thinking=off|minimal|low|medium|high|xhigh|max");
console.log("next=save config.json, then run how-to-use --verify-config");

if (created || reconfigure) {
  const child = spawn("notepad.exe", [configPath], {
    detached: true, stdio: "ignore", windowsHide: false
  });
  child.unref();
  console.log("editor=notepad");
}