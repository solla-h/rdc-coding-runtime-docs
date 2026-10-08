import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { managedSkillLinkRoots } from "./skill-hub-roots.mjs";

export const CAPABILITY_SCHEMA_VERSION = 2;
export const CAPABILITY_RUNTIME_VERSION = "0.7.0-dev.1";
export const DEFAULT_MAX_CONTEXT_BYTES = 48 * 1024;
export const DEFAULT_MAX_CONTEXT_ITEMS = 120;
const DEFAULT_MAX_SKILLS = 180;
const DEFAULT_MAX_SKILL_DEPTH = 7;
const MAX_MACHINE_HINT_CHARS = 2200;
const MAX_PROJECT_EVIDENCE = 16;
const SKIP_DIRS = new Set(["node_modules", ".git", "data", "sessions"]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function readTextFile(filePath, maxChars = 20000) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function cleanScalar(value) {
  const trimmed = String(value ?? "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function frontmatterBlock(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const end = normalized.indexOf("\n---", 4);
  return end >= 0 ? normalized.slice(4, end) : "";
}

export function parseSkillFrontmatter(text) {
  const block = frontmatterBlock(text.slice(0, 12000));
  if (!block) return { name: null, description: "", bins: [] };
  const lines = block.split("\n");
  let name = null;
  let description = "";
  const bins = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, raw] = keyMatch;
    if (key === "name") {
      name = cleanScalar(raw) || null;
      continue;
    }
    if (key === "description") {
      if (raw === ">" || raw === "|-" || raw === "|" || raw === ">-") {
        const chunks = [];
        while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
          i += 1;
          chunks.push(lines[i].replace(/^\s+/, ""));
        }
        description = raw.startsWith(">")
          ? chunks.join(" ").replace(/\s+/g, " ").trim()
          : chunks.join("\n").trim();
      } else {
        description = cleanScalar(raw);
      }
      continue;
    }
    if (key === "bins") {
      const inner = raw.match(/^\[(.*)\]$/)?.[1];
      if (inner !== undefined) {
        for (const item of inner.split(",")) {
          const value = cleanScalar(item);
          if (/^[A-Za-z0-9_.-]+$/.test(value)) bins.push(value);
        }
      }
    }
  }

  return {
    name,
    description: description.slice(0, 1200),
    bins: [...new Set(bins)],
  };
}

function normalizeForId(value) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function shortHash(value, length = 10) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function slug(value) {
  const cleaned = String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 48) || "capability";
}

function withinRoot(rootReal, targetReal) {
  const relative = path.relative(rootReal, targetReal);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function skillId(alias, rootPath, skillDir, name) {
  const relative = path.relative(rootPath, skillDir).replaceAll("\\", "/") || ".";
  return `skill:${alias}:${slug(name)}:${shortHash(relative)}`;
}

function commandId(adapter, scope, name, location = "") {
  return `command:${adapter}:${slug(name)}:${shortHash(`${scope}\0${location || name}`)}`;
}

function observation(now, facts, notChecked) {
  return {
    observedAt: now,
    facts: [...new Set(facts)],
    notChecked: [...new Set(notChecked)],
  };
}

function safeStatReal(filePath) {
  try {
    return {
      stat: fs.lstatSync(filePath),
      targetStat: fs.statSync(filePath),
      real: fs.realpathSync(filePath),
    };
  } catch {
    return null;
  }
}

function discoverSkillRoot({ alias, rootPath, maxDepth, remaining, now, allowedRootReals = [] }) {
  const records = [];
  const problems = [];
  const rootState = safeStatReal(rootPath);
  if (!rootState?.targetStat.isDirectory()) {
    return { records, problems, checked: false, truncated: false };
  }
  const rootReal = rootState.real;
  const visited = new Set();
  let truncated = false;

  function visit(dir, depth) {
    if (records.length >= remaining) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    const state = safeStatReal(dir);
    if (!state) {
      problems.push(`${alias}: unreadable ${dir}`);
      return;
    }
    const allowedRoots = allowedRootReals.length ? allowedRootReals : [rootReal];
    if (!allowedRoots.some(allowedRoot => withinRoot(allowedRoot, state.real))) {
      problems.push(`${alias}: skipped link outside allowed roots: ${dir}`);
      return;
    }
    if (visited.has(state.real)) return;
    visited.add(state.real);
    if (!state.targetStat.isDirectory()) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      problems.push(`${alias}: unreadable directory ${dir}`);
      return;
    }

    const skillEntry = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === "skill.md");
    if (skillEntry) {
      const skillPath = path.join(dir, skillEntry.name);
      const text = readTextFile(skillPath, 12000);
      const meta = parseSkillFrontmatter(text);
      if (!meta.name) {
        problems.push(`${alias}: SKILL.md missing valid name: ${skillPath}`);
        return;
      }
      records.push({
        id: skillId(alias, rootPath, dir, meta.name),
        kind: "skill",
        name: meta.name,
        summary: meta.description || `Local Skill from ${alias}`,
        source: { adapter: "skill", root: alias, location: skillPath },
        details: {
          skillPath,
          resourceBase: dir,
          bins: meta.bins,
        },
        observation: observation(now,
          ["skill_definition_found"],
          ["required_cli_resolved", "authentication", "network_reachability", "runtime_success"]),
      });
      return;
    }

    for (const entry of entries) {
      if (records.length >= remaining) {
        truncated = true;
        break;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child, depth + 1);
      } else if (entry.isSymbolicLink()) {
        const target = safeStatReal(child);
        if (target) visit(child, depth + 1);
      }
    }
  }

  visit(rootPath, 0);
  return { records, problems, checked: true, truncated };
}

function adoptedWorkspaceSkillRoots(workspace) {
  if (!workspace) return [];
  const instructionFiles = [
    path.join(workspace, "AGENTS.md"),
    path.join(workspace, "CLAUDE.md"),
    path.join(workspace, "GEMINI.md"),
    path.join(workspace, ".github", "copilot-instructions.md"),
  ];
  const instructions = instructionFiles
    .filter(filePath => fs.existsSync(filePath))
    .map(filePath => readTextFile(filePath, 30000).replaceAll("\\", "/"))
    .join("\n");
  const roots = [];
  if (instructions.includes(".agents/skills")) {
    roots.push({ alias: "workspace-agents", path: path.join(workspace, ".agents", "skills") });
  }
  if (instructions.includes(".pi/agent/skills")) {
    roots.push({ alias: "workspace-pi", path: path.join(workspace, ".pi", "agent", "skills") });
  }
  return roots;
}

export function defaultSkillRoots({ home = os.homedir(), workspace = null } = {}) {
  return [
    { alias: "agents", path: path.join(home, ".agents", "skills") },
    { alias: "pi", path: path.join(home, ".pi", "agent", "skills") },
    ...managedSkillLinkRoots({ home }),
    ...adoptedWorkspaceSkillRoots(workspace),
  ];
}

export function discoverSkillRecords({
  home = os.homedir(),
  workspace = null,
  skillRoots = null,
  maxSkills = DEFAULT_MAX_SKILLS,
  maxDepth = DEFAULT_MAX_SKILL_DEPTH,
  now = new Date().toISOString(),
} = {}) {
  const roots = skillRoots ?? defaultSkillRoots({ home, workspace });
  const records = [];
  const sourcesChecked = [];
  const incompleteSources = [];
  const seenTargets = new Set();
  const allowedRootReals = roots
    .map(root => safeStatReal(root.path))
    .filter(state => state?.targetStat.isDirectory())
    .map(state => state.real);

  for (const root of roots) {
    if (records.length >= maxSkills) {
      incompleteSources.push(`${root.alias}: global skill limit ${maxSkills} reached`);
      break;
    }
    const result = discoverSkillRoot({
      alias: root.alias,
      rootPath: root.path,
      maxDepth,
      remaining: maxSkills,
      now,
      allowedRootReals,
    });
    if (result.checked) sourcesChecked.push(`skill:${root.alias}`);
    for (const record of result.records) {
      let targetKey = normalizeForId(record.details.skillPath);
      try { targetKey = normalizeForId(fs.realpathSync(record.details.skillPath)); } catch {}
      if (seenTargets.has(targetKey)) continue;
      seenTargets.add(targetKey);
      records.push(record);
      if (records.length >= maxSkills) break;
    }
    incompleteSources.push(...result.problems);
    if (result.truncated) incompleteSources.push(`skill:${root.alias}: bounded discovery truncated`);
  }

  return { records, sourcesChecked, incompleteSources };
}

function projectHash(workspace) {
  return shortHash(normalizeForId(workspace), 10);
}

function packageManagerFor(workspace, pkg) {
  const explicit = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
  if (explicit) return explicit;
  if (fs.existsSync(path.join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(workspace, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(workspace, "package-lock.json")) ||
      fs.existsSync(path.join(workspace, "npm-shrinkwrap.json"))) return "npm";
  return null;
}

function parsePyprojectScripts(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let section = "";
  const scripts = [];
  let hasPytestConfig = false;
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (section === "tool.pytest.ini_options") hasPytestConfig = true;
      continue;
    }
    if (section !== "project.scripts") continue;
    const item = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
    if (item) scripts.push({ name: item[1], target: item[2] });
  }
  return { scripts, hasPytestConfig };
}

export function discoverProjectRecords({ workspace = null, now = new Date().toISOString() } = {}) {
  const records = [];
  const evidence = [];
  const sourcesChecked = [];
  const incompleteSources = [];
  if (!workspace) return { records, evidence, sourcesChecked, incompleteSources };

  let stat;
  try {
    stat = fs.statSync(workspace);
  } catch {
    incompleteSources.push(`workspace: not readable: ${workspace}`);
    return { records, evidence, sourcesChecked, incompleteSources };
  }
  if (!stat.isDirectory()) {
    incompleteSources.push(`workspace: not a directory: ${workspace}`);
    return { records, evidence, sourcesChecked, incompleteSources };
  }

  const scope = projectHash(workspace);
  const packageJson = path.join(workspace, "package.json");
  if (fs.existsSync(packageJson)) {
    sourcesChecked.push("project:package.json");
    const pkg = readJson(packageJson);
    if (!pkg) {
      incompleteSources.push("project:package.json: invalid JSON");
    } else {
      const pm = packageManagerFor(workspace, pkg);
      if (pm) evidence.push({ source: packageJson, fact: `package manager evidence: ${pm}` });
      else evidence.push({ source: packageJson, fact: "package manager not determined from packageManager or lockfile" });
      if (typeof pkg.packageManager === "string") {
        evidence.push({ source: packageJson, fact: `packageManager declared: ${pkg.packageManager}` });
      }
      const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command !== "string") continue;
        const invocation = pm ? `${pm} run ${name}` : null;
        records.push({
          id: commandId("package-script", scope, name, name),
          kind: "command",
          name: `package script: ${name}`,
          summary: `Project script '${name}' declared in package.json; package manager and runtime availability are evidence-dependent`,
          source: { adapter: "package-script", location: packageJson },
          details: {
            command: invocation,
            scriptName: name,
            declaredScript: command,
            cwd: workspace,
            launchType: "project-script",
          },
          observation: observation(now,
            ["project_script_declared"],
            ["dependencies_installed", "command_resolves", "runtime_success"]),
        });
      }
    }
  }

  const pyproject = path.join(workspace, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    sourcesChecked.push("project:pyproject.toml");
    const text = readTextFile(pyproject, 80000);
    const parsed = parsePyprojectScripts(text);
    if (parsed.hasPytestConfig) {
      evidence.push({ source: pyproject, fact: "pytest configuration declared; pytest executable not checked" });
    }
    for (const item of parsed.scripts) {
      records.push({
        id: commandId("pyproject-script", scope, item.name, item.name),
        kind: "command",
        name: item.name,
        summary: `Python console script '${item.name}' declared in pyproject.toml; environment not verified`,
        source: { adapter: "pyproject-script", location: pyproject },
        details: {
          command: item.name,
          declaredTarget: item.target,
          cwd: workspace,
          launchType: "python-console-script",
        },
        observation: observation(now,
          ["python_console_script_declared"],
          ["environment_installed", "command_resolves", "runtime_success"]),
      });
    }
  }

  for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const p = path.join(workspace, file);
    if (fs.existsSync(p)) {
      evidence.push({ source: p, fact: `${file} present; repository guidance should be read before editing` });
    }
  }

  return { records, evidence, sourcesChecked, incompleteSources };
}

function isSafeCommandName(name) {
  return /^[A-Za-z0-9_.-]+$/.test(String(name || ""));
}

function defaultCommandResolver(name) {
  if (!isSafeCommandName(name)) return [];
  const command = process.platform === "win32" ? "where.exe" : "which";
  const run = spawnSync(command, [name], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
    shell: false,
  });
  if (run.status !== 0) return [];
  return (run.stdout || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function launchTypeFor(location) {
  const ext = path.extname(location).toLowerCase();
  if (ext === ".cmd") return "cmd-shim";
  if (ext === ".bat") return "batch";
  if (ext === ".ps1") return "powershell-script";
  if (ext === ".exe") return "executable";
  return ext ? ext.slice(1) : "executable";
}

export function discoverExactCommandRecords({
  names = [],
  workspace = null,
  resolver = defaultCommandResolver,
  now = new Date().toISOString(),
} = {}) {
  const candidates = [...new Set(names.map(name => String(name).trim()).filter(isSafeCommandName))].slice(0, 12);
  const records = [];
  const sourcesChecked = [];
  for (const name of candidates) {
    let locations = [];
    try {
      locations = resolver(name) || [];
    } catch {
      locations = [];
    }
    sourcesChecked.push(`command:${name}`);
    if (!locations.length) continue;
    const first = locations[0];
    records.push({
      id: commandId("path", workspace ? projectHash(workspace) : "machine", name, first),
      kind: "command",
      name,
      summary: `Local command '${name}' resolved from the current process environment`,
      source: { adapter: "path-command", location: first },
      details: {
        command: name,
        resolvedPaths: locations,
        cwd: workspace,
        launchType: launchTypeFor(first),
        helpHint: `${name} --help`,
      },
      observation: observation(now,
        ["command_resolves"],
        ["help_read", "authentication", "network_reachability", "runtime_success"]),
    });
  }
  return { records, sourcesChecked, incompleteSources: [] };
}
function sanitizeMachineHints(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const safe = [];
  for (const line of lines) {
    if (/(api[_ -]?key|password|private[_ -]?key|secret|bearer\s+|access[_ -]?token)/i.test(line)) continue;
    safe.push(line);
    if (safe.join("\n").length >= MAX_MACHINE_HINT_CHARS) break;
  }
  return safe.join("\n").slice(0, MAX_MACHINE_HINT_CHARS).trim();
}

function uniqueRecords(records) {
  const map = new Map();
  for (const record of records) map.set(record.id, record);
  return [...map.values()];
}

export function discoverCapabilityRecords({
  home = os.homedir(),
  workspace = null,
  commandNames = [],
  skillRoots = null,
  resolver = defaultCommandResolver,
  now = new Date().toISOString(),
  maxSkills = DEFAULT_MAX_SKILLS,
  maxSkillDepth = DEFAULT_MAX_SKILL_DEPTH,
} = {}) {
  const skills = discoverSkillRecords({
    home, workspace, skillRoots, maxSkills, maxDepth: maxSkillDepth, now,
  });
  const project = discoverProjectRecords({ workspace, now });
  const commands = discoverExactCommandRecords({
    names: commandNames, workspace, resolver, now,
  });
  const machineContextPath = path.join(home, ".rdc", "MACHINE_CONTEXT.md");
  const machineHints = sanitizeMachineHints(readTextFile(machineContextPath, 6000));
  const sourcesChecked = [...new Set([
    ...skills.sourcesChecked,
    ...project.sourcesChecked,
    ...commands.sourcesChecked,
    ...(fs.existsSync(machineContextPath) ? ["machine:MACHINE_CONTEXT.md"] : []),
  ])];
  const incompleteSources = [...new Set([
    ...skills.incompleteSources,
    ...project.incompleteSources,
    ...commands.incompleteSources,
  ])];

  return {
    records: uniqueRecords([...project.records, ...skills.records, ...commands.records]),
    machineHints,
    projectEvidence: project.evidence.slice(0, MAX_PROJECT_EVIDENCE),
    coverage: { sourcesChecked, incompleteSources },
    observedAt: now,
  };
}

function summaryOf(record) {
  const hints = {};
  if (record.kind === "skill" && record.details?.bins?.length) {
    hints.declaredBins = [...record.details.bins];
  }
  if (record.kind === "command" && record.details?.command) {
    hints.command = record.details.command;
  }
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    summary: record.summary,
    source: record.source,
    observation: record.observation,
    ...(Object.keys(hints).length ? { hints } : {}),
  };
}

function catalogPriority(record) {
  if (record.source?.adapter === "package-script" || record.source?.adapter === "pyproject-script") return 0;
  if (record.source?.adapter === "path-command") return 1;
  if (record.kind === "skill") return 2;
  return 3;
}

function sortedCatalog(records) {
  return [...records].sort((a, b) =>
    catalogPriority(a) - catalogPriority(b) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id));
}

function truncateString(value, maxChars) {
  const text = String(value || "");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 16))}\n...[truncated]`;
}

function compactCoverageLists(coverage) {
  if (coverage.incompleteSources.length > 1) {
    const omitted = coverage.incompleteSources.length - 1;
    coverage.incompleteSources = [
      coverage.incompleteSources[0],
      `${omitted} additional incomplete source(s) omitted`,
    ];
    coverage.hasMore = true;
  }
  if (coverage.sourcesChecked.length > 8) {
    const omitted = coverage.sourcesChecked.length - 7;
    coverage.sourcesChecked = [
      ...coverage.sourcesChecked.slice(0, 7),
      `${omitted} additional checked source(s) omitted`,
    ];
    coverage.hasMore = true;
  }
}

function fitSnapshot(snapshot, maxBytes) {
  const copy = structuredClone(snapshot);
  copy.machineHints = truncateString(copy.machineHints, MAX_MACHINE_HINT_CHARS);
  copy.projectEvidence = copy.projectEvidence.slice(0, MAX_PROJECT_EVIDENCE);
  while (byteLength(JSON.stringify(copy)) > maxBytes && copy.projectEvidence.length > 0) {
    copy.projectEvidence.pop();
    copy.coverage.hasMore = true;
  }
  if (byteLength(JSON.stringify(copy)) > maxBytes) {
    copy.machineHints = truncateString(copy.machineHints, 600);
    copy.coverage.hasMore = true;
  }
  while (byteLength(JSON.stringify(copy)) > maxBytes && copy.capabilities.length > 1) {
    copy.capabilities.pop();
    copy.coverage.hasMore = true;
  }
  if (byteLength(JSON.stringify(copy)) > maxBytes) {
    compactCoverageLists(copy.coverage);
  }
  if (byteLength(JSON.stringify(copy)) > maxBytes) {
    copy.machineHints = "";
    copy.coverage.hasMore = true;
  }
  if (byteLength(JSON.stringify(copy)) > maxBytes) {
    copy.capabilities = [];
    copy.coverage.hasMore = true;
  }
  if (byteLength(JSON.stringify(copy)) > maxBytes) {
    throw new Error(`capability context JSON exceeds byte budget (${byteLength(JSON.stringify(copy))} > ${maxBytes})`);
  }
  return copy;
}

export function buildContextSnapshot({
  home = os.homedir(),
  workspace = null,
  query = "",
  commandNames = [],
  skillRoots = null,
  resolver = defaultCommandResolver,
  maxItems = DEFAULT_MAX_CONTEXT_ITEMS,
  maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
  now = new Date().toISOString(),
} = {}) {
  const discovered = discoverCapabilityRecords({
    home, workspace, commandNames, skillRoots, resolver, now,
  });
  const catalog = sortedCatalog(discovered.records);
  const selected = catalog.slice(0, maxItems).map(summaryOf);
  const hasMore = catalog.length > selected.length || discovered.coverage.incompleteSources.length > 0;
  const snapshot = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    runtimeVersion: CAPABILITY_RUNTIME_VERSION,
    host: { platform: process.platform, arch: process.arch },
    workspace: workspace ? path.resolve(workspace) : null,
    observedAt: discovered.observedAt,
    task: query || null,
    semanticSelectionPerformed: false,
    machineHints: discovered.machineHints,
    projectEvidence: discovered.projectEvidence,
    capabilities: selected,
    coverage: {
      ...discovered.coverage,
      hasMore,
    },
    next: {
      find: "rdc-cap find <exact-name-or-id> --workspace <path>",
      describe: "rdc-cap describe <capability-id> --workspace <path>",
      semantic: "how-to-use --workspace <path> <task>",
    },
  };
  return fitSnapshot(snapshot, maxBytes);
}

export function findCapabilityMatches(lookup, {
  home = os.homedir(),
  workspace = null,
  skillRoots = null,
  resolver = defaultCommandResolver,
  maxItems = 20,
  maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
  now = new Date().toISOString(),
} = {}) {
  const target = String(lookup || "").trim();
  const commandHint = commandQueryHintFromId(target);
  const commandNames = isSafeCommandName(target)
    ? [target]
    : (commandHint ? [commandHint] : []);
  const discovered = discoverCapabilityRecords({
    home, workspace, commandNames, skillRoots, resolver, now,
  });
  const lower = target.toLowerCase();
  const matches = sortedCatalog(discovered.records)
    .filter(record => record.id === target || record.name.toLowerCase() === lower)
    .slice(0, maxItems)
    .map(summaryOf);
  const result = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    runtimeVersion: CAPABILITY_RUNTIME_VERSION,
    observedAt: discovered.observedAt,
    workspace: workspace ? path.resolve(workspace) : null,
    lookup: truncateString(target, 1000),
    semanticSelectionPerformed: false,
    matches,
    coverage: {
      ...discovered.coverage,
      hasMore: discovered.coverage.incompleteSources.length > 0,
    },
    next: {
      describe: "rdc-cap describe <capability-id> --workspace <path>",
      semantic: "how-to-use --workspace <path> <task>",
    },
  };
  while (byteLength(JSON.stringify(result)) > maxBytes && result.matches.length > 1) {
    result.matches.pop();
    result.coverage.hasMore = true;
  }
  if (byteLength(JSON.stringify(result)) > maxBytes) {
    compactCoverageLists(result.coverage);
  }
  if (byteLength(JSON.stringify(result)) > maxBytes && result.matches.length) {
    result.matches = [];
    result.coverage.hasMore = true;
  }
  if (byteLength(JSON.stringify(result)) > maxBytes) {
    result.lookup = truncateString(result.lookup, 300);
  }
  if (byteLength(JSON.stringify(result)) > maxBytes) {
    throw new Error(`capability find result exceeds byte budget (${byteLength(JSON.stringify(result))} > ${maxBytes})`);
  }
  return result;
}
function commandQueryHintFromId(capabilityId) {
  const match = String(capabilityId || "").match(/^command:path:([a-z0-9._-]{1,48}):[a-f0-9]{10}$/);
  return match?.[1] || "";
}

export function describeCapability(capabilityId, {
  home = os.homedir(),
  workspace = null,
  skillRoots = null,
  resolver = defaultCommandResolver,
  now = new Date().toISOString(),
  maxSkillContentChars = 9000,
} = {}) {
  const commandHint = commandQueryHintFromId(capabilityId);
  const discovered = discoverCapabilityRecords({
    home,
    workspace,
    commandNames: commandHint ? [commandHint] : [],
    skillRoots,
    resolver,
    now,
  });
  const record = discovered.records.find(item => item.id === capabilityId);
  if (!record) {
    return {
      found: false,
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      runtimeVersion: CAPABILITY_RUNTIME_VERSION,
      observedAt: discovered.observedAt,
      capabilityId,
      coverage: {
        ...discovered.coverage,
        hasMore: discovered.coverage.incompleteSources.length > 0,
      },
    };
  }

  const descriptor = {
    found: true,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    runtimeVersion: CAPABILITY_RUNTIME_VERSION,
    observedAt: discovered.observedAt,
    capability: {
      ...summaryOf(record),
      details: record.details,
    },
  };
  if (record.kind === "skill") {
    const full = readTextFile(record.details.skillPath, maxSkillContentChars + 1);
    descriptor.capability.details.content = full.slice(0, maxSkillContentChars);
    descriptor.capability.details.contentComplete = full.length <= maxSkillContentChars;
    if (full.length > maxSkillContentChars) {
      descriptor.capability.details.readFullPath = record.details.skillPath;
    }
  }
  return descriptor;
}

function markdownList(values, empty = "- none") {
  return values.length ? values.map(value => `- ${value}`).join("\n") : empty;
}

function renderContextMarkdownBody(snapshot) {
  const lines = [
    "# RDC capability context",
    "",
    `- runtime: ${snapshot.runtimeVersion}`,
    `- observed: ${snapshot.observedAt}`,
    `- workspace: ${snapshot.workspace || "(machine-level)"}`,
    `- coverage complete: ${snapshot.coverage.incompleteSources.length === 0 && !snapshot.coverage.hasMore}`,
  ];
  if (snapshot.machineHints) lines.push("", "## Machine hints", "", snapshot.machineHints);
  if (snapshot.projectEvidence.length) {
    lines.push("", "## Project evidence", "");
    for (const item of snapshot.projectEvidence) lines.push(`- ${item.fact} (${item.source})`);
  }
  lines.push("", "## Capability catalog (unranked)", "");
  lines.push("Semantic selection was not performed by rdc-cap; the caller/LLM must reason over these evidence-backed summaries.");
  if (!snapshot.capabilities.length) {
    lines.push("- No capability records were found in the bounded sources checked.");
  } else {
    for (const item of snapshot.capabilities) {
      const hints = item.hints?.declaredBins?.length ? ` [declared bins: ${item.hints.declaredBins.join(", ")}]` : "";
      lines.push(`- \`${item.id}\` — **${item.name}** (${item.kind}): ${item.summary}${hints}`);
    }
  }
  lines.push("", "## Coverage", "", `Checked: ${snapshot.coverage.sourcesChecked.join(", ") || "none"}`);
  if (snapshot.coverage.incompleteSources.length) {
    lines.push("", "Incomplete:", markdownList(snapshot.coverage.incompleteSources));
  }
  if (snapshot.coverage.hasMore) lines.push("", "The catalog is bounded or source coverage is incomplete; absence from this snapshot is not proof of absence.");
  lines.push("", "## Next", "", `- ${snapshot.next.find}`, `- ${snapshot.next.describe}`, `- ${snapshot.next.semantic}`);
  return lines.join("\n");
}

export function renderContextMarkdown(snapshot, maxBytes = DEFAULT_MAX_CONTEXT_BYTES) {
  const copy = structuredClone(snapshot);
  let rendered = renderContextMarkdownBody(copy);
  while (byteLength(rendered) > maxBytes && copy.capabilities.length > 1) {
    copy.capabilities.pop();
    copy.coverage.hasMore = true;
    rendered = renderContextMarkdownBody(copy);
  }
  while (byteLength(rendered) > maxBytes && copy.projectEvidence.length > 0) {
    copy.projectEvidence.pop();
    copy.coverage.hasMore = true;
    rendered = renderContextMarkdownBody(copy);
  }
  while (byteLength(rendered) > maxBytes && copy.coverage.incompleteSources.length > 1) {
    const omitted = copy.coverage.incompleteSources.length - 1;
    copy.coverage.incompleteSources = [copy.coverage.incompleteSources[0], `${omitted} additional incomplete source(s) omitted`];
    copy.coverage.hasMore = true;
    rendered = renderContextMarkdownBody(copy);
    break;
  }
  if (byteLength(rendered) > maxBytes && copy.coverage.sourcesChecked.length > 8) {
    const omitted = copy.coverage.sourcesChecked.length - 7;
    copy.coverage.sourcesChecked = [
      ...copy.coverage.sourcesChecked.slice(0, 7),
      `${omitted} additional checked source(s) omitted`,
    ];
    copy.coverage.hasMore = true;
    rendered = renderContextMarkdownBody(copy);
  }
  if (byteLength(rendered) > maxBytes && copy.machineHints) {
    copy.machineHints = truncateString(copy.machineHints, 320);
    copy.coverage.hasMore = true;
    rendered = renderContextMarkdownBody(copy);
  }
  if (byteLength(rendered) > maxBytes && copy.machineHints) {
    copy.machineHints = "";
    copy.coverage.hasMore = true;
    rendered = renderContextMarkdownBody(copy);
  }
  if (byteLength(rendered) > maxBytes) {
    throw new Error(`capability context markdown exceeds byte budget (${byteLength(rendered)} > ${maxBytes})`);
  }
  return rendered;
}

export function renderFindMarkdown(result) {
  const lines = [
    "# RDC exact capability lookup",
    "",
    `Lookup: ${result.lookup}`,
    `Workspace: ${result.workspace || "(machine-level)"}`,
    "",
    "Semantic selection was not performed; matches require an exact capability ID or display name.",
    "",
  ];
  if (!result.matches.length) {
    lines.push("No exact capability match was found in the bounded sources checked.");
  } else {
    for (const item of result.matches) {
      lines.push(`- \`${item.id}\` — **${item.name}** (${item.kind}): ${item.summary}`);
    }
  }
  if (result.coverage.incompleteSources.length) {
    lines.push("", "Incomplete coverage:", markdownList(result.coverage.incompleteSources));
  }
  lines.push("", `Next: ${result.next.describe}`, `Semantic routing: ${result.next.semantic}`);
  return lines.join("\n");
}

export function renderDescribeMarkdown(result) {
  if (!result.found) {
    const suffix = result.coverage?.incompleteSources?.length
      ? ` Coverage was incomplete: ${result.coverage.incompleteSources.join("; ")}`
      : "";
    return `Capability not found in the bounded sources checked: ${result.capabilityId}.${suffix}`;
  }
  const item = result.capability;
  const lines = [
    `# ${item.name}`,
    "",
    `- id: \`${item.id}\``,
    `- kind: ${item.kind}`,
    `- source: ${item.source.adapter} — ${item.source.location}`,
    `- observed: ${item.observation.observedAt}`,
    "",
    item.summary,
    "",
    "## Verified facts",
    "",
    markdownList(item.observation.facts),
    "",
    "## Not checked",
    "",
    markdownList(item.observation.notChecked),
  ];
  if (item.kind === "skill") {
    lines.push("", "## Skill instructions", "", item.details.content || "(empty)");
    if (!item.details.contentComplete) {
      lines.push("", `Full instructions must be read before execution: ${item.details.readFullPath}`);
    }
  } else {
    lines.push("", "## Invocation", "");
    if (item.details.command) lines.push(`- command: ${item.details.command}`);
    else if (item.details.scriptName) lines.push(`- package script: ${item.details.scriptName} (package manager not determined)`);
    if (item.details.cwd) lines.push(`- cwd: ${item.details.cwd}`);
    if (item.details.declaredScript) lines.push(`- declared script: ${item.details.declaredScript}`);
    if (item.details.declaredTarget) lines.push(`- declared target: ${item.details.declaredTarget}`);
    if (item.details.helpHint) lines.push(`- help hint: ${item.details.helpHint}`);
    if (item.details.resolvedPaths) lines.push(`- resolved paths: ${item.details.resolvedPaths.join(", ")}`);
  }
  return lines.join("\n");
}
