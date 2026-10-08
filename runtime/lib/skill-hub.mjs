import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { discoverSkillRecords } from "./capabilities.mjs";

const SCHEMA = 1;
const SKIP_DIRS = new Set([".git", "node_modules", ".cache"]);
const VALID_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function present(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeName(value) {
  return typeof value === "string" && VALID_NAME.test(value) &&
    value !== "." && value !== ".." && !value.startsWith(".skill-hub-");
}

function fileTree(dir) {
  const hash = crypto.createHash("sha256");
  let newest = 0;
  let count = 0;
  function visit(current, depth) {
    if (depth > 12) throw new Error("Skill resource depth exceeded: " + dir);
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      if (SKIP_DIRS.has(child.name) || /^\.?[a-z0-9][a-z0-9._-]*-install\.json$/i.test(child.name)) continue;
      const full = path.join(current, child.name);
      const rel = path.relative(dir, full).replaceAll("\\", "/");
      const stat = fs.lstatSync(full);
      count += 1;
      if (count > 5000) throw new Error("Skill resource count exceeded: " + dir);
      if (stat.isSymbolicLink()) {
        hash.update("link:" + rel + ":" + fs.readlinkSync(full) + "\n");
      } else if (stat.isDirectory()) {
        visit(full, depth + 1);
      } else if (stat.isFile()) {
        newest = Math.max(newest, stat.mtimeMs);
        hash.update("file:" + rel + ":" + stat.size + "\n");
        const fd = fs.openSync(full, "r");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        try {
          while (true) {
            const n = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (n === 0) break;
            hash.update(buffer.subarray(0, n));
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  }
  visit(dir, 0);
  return { fingerprint: hash.digest("hex"), newestMtimeMs: newest };
}

function manifestForSkill(dir, diagnostics) {
  const manifests = fs.readdirSync(dir).filter(name =>
    /^\.?[a-z0-9][a-z0-9._-]*-install\.json$/i.test(name)).sort();
  if (!manifests.length) return null;
  if (manifests.length > 1) {
    diagnostics.push("multiple install manifests in " + dir);
    return null;
  }
  try {
    const filename = manifests[0];
    const value = readJson(path.join(dir, filename));
    const id = filename.replace(/^\./, "").replace(/-install\.json$/i, "").toLowerCase();
    return {
      id,
      version: String(value.installedVersion || ""),
      commit: String(value.buildCommit || ""),
    };
  } catch (error) {
    diagnostics.push("invalid install manifest in " + dir + ": " + error.message);
    return null;
  }
}

function pluginSources(home, diagnostics) {
  const registry = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const settings = path.join(home, ".claude", "settings.json");
  if (!present(registry) || !present(settings)) return [];
  try {
    const data = readJson(registry);
    const enabled = readJson(settings).enabledPlugins || {};
    const sources = [];
    for (const [pluginId, installs] of Object.entries(data.plugins || {})) {
      if (enabled[pluginId] !== true) continue;
      for (const install of Array.isArray(installs) ? installs : [installs]) {
        if (typeof install?.installPath !== "string") continue;
        const location = path.resolve(install.installPath, "skills");
        if (!present(location)?.isDirectory()) continue;
        sources.push({ alias: "claude-plugin-" + sha(pluginId + ":" + location), path: location });
      }
    }
    return sources;
  } catch (error) {
    diagnostics.push("Claude plugin registry could not be read: " + error.message);
    return [];
  }
}

export function defaultHubSources({ home = os.homedir(), hub = path.join(home, ".agents", "skills") } = {}) {
  const diagnostics = [];
  return {
    sources: [
      { alias: "hub", path: hub },
      { alias: "pi", path: path.join(home, ".pi", "agent", "skills") },
      { alias: "claude", path: path.join(home, ".claude", "skills") },
      { alias: "codex", path: path.join(home, ".codex", "skills") },
      { alias: "kiro", path: path.join(home, ".kiro", "skills") },
      ...pluginSources(home, diagnostics),
    ],
    diagnostics,
  };
}

export function ledgerPath(home = os.homedir()) {
  return path.join(home, ".rdc", "skill-hub", "links.json");
}

function readLedger(statePath, hub) {
  if (!present(statePath)) return { schema: SCHEMA, hub, links: {} };
  const ledger = readJson(statePath);
  if (ledger.schema !== SCHEMA || !samePath(ledger.hub, hub) ||
      !ledger.links || typeof ledger.links !== "object" || Array.isArray(ledger.links)) {
    throw new Error("Skill Hub ledger invalid or for another hub: " + statePath);
  }
  for (const [name, item] of Object.entries(ledger.links)) {
    if (!safeName(name) || typeof item?.target !== "string" ||
        typeof item.group !== "string" || typeof item.source !== "string") {
      throw new Error("Skill Hub ledger entry invalid: " + name);
    }
  }
  return ledger;
}

function verifiedOwnedLink(hub, name, item) {
  const dest = path.join(hub, name);
  if (!present(dest)?.isSymbolicLink()) return false;
  try { return samePath(fs.realpathSync(dest), fs.realpathSync(item.target)); }
  catch { return false; }
}

function sourceList({ home, hub, sources, diagnostics }) {
  const defaults = sources === null ? defaultHubSources({ home, hub }) : { sources: [
    { alias: "hub", path: hub }, ...sources,
  ], diagnostics: [] };
  diagnostics.push(...defaults.diagnostics);
  const used = new Set();
  return defaults.sources.map(source => ({
    alias: String(source.alias),
    path: path.resolve(source.path),
  })).filter(source => {
    if (!VALID_NAME.test(source.alias)) throw new Error("Invalid source alias: " + source.alias);
    if (used.has(source.alias)) throw new Error("Duplicate source alias: " + source.alias);
    used.add(source.alias);
    return true;
  });
}

function groupManifest(candidates, explicitGroups, diagnostics) {
  const groupForName = new Map();
  for (const entry of candidates) {
    if (!entry.bundle) continue;
    const key = entry.name.toLowerCase();
    const previous = groupForName.get(key);
    if (previous && previous !== entry.bundle.id) {
      diagnostics.push("Skill in conflicting bundle families: " + entry.name);
    } else groupForName.set(key, entry.bundle.id);
  }
  for (const [bundle, members] of Object.entries(explicitGroups || {})) {
    if (!safeName(bundle) || !Array.isArray(members)) throw new Error("Invalid bundle declaration: " + bundle);
    for (const name of members) {
      if (!safeName(name)) throw new Error("Invalid bundle member: " + name);
      const previous = groupForName.get(name.toLowerCase());
      if (previous && previous !== bundle) {
        diagnostics.push("Skill in conflicting bundle families: " + name);
      } else groupForName.set(name.toLowerCase(), bundle);
    }
  }
  return groupForName;
}

function compareCandidates(a, b) {
  return b.mtimeMs - a.mtimeMs ||
    a.source.localeCompare(b.source, "en") ||
    a.target.localeCompare(b.target, "en");
}

export function planSkillHub({
  home = os.homedir(),
  hub = path.join(home, ".agents", "skills"),
  statePath = ledgerPath(home),
  sources = null,
  groups = {},
  maxSkills = 20000,
} = {}) {
  hub = path.resolve(hub);
  statePath = path.resolve(statePath);
  const ledger = readLedger(statePath, hub);
  const diagnostics = [];
  const allSources = sourceList({ home, hub, sources, diagnostics });
  const allowTargets = allSources.map(x => x.path);
  const candidates = [];
  const checked = [];
  const incomplete = [];
  const aliases = new Set();
  for (const source of allSources) {
    if (aliases.has(source.alias)) throw new Error("Duplicate source alias: " + source.alias);
    aliases.add(source.alias);
    if (!present(source.path)?.isDirectory()) continue;
    // Give the existing scanner the complete explicit root set for its
    // realpath containment checks, but inspect only this root's records.
    // This preserves links from Pi to .agents without loosening its boundary.
    const found = discoverSkillRecords({
      skillRoots: [source, ...allSources.filter(other => other.alias !== source.alias)],
      maxSkills,
    });
    checked.push(source.alias);
    incomplete.push(...found.incompleteSources.filter(problem =>
      problem.startsWith(source.alias + ":") ||
      problem.startsWith("skill:" + source.alias + ":")));
    for (const record of found.records.filter(item => item.source.root === source.alias)) {
      const name = record.name;
      if (!safeName(name)) {
        diagnostics.push("Invalid Skill name ignored: " + name);
        continue;
      }
      if (source.alias === "codex" && record.details.skillPath.toLowerCase()
        .split(path.sep).includes(".system")) continue;
      const target = path.dirname(record.details.skillPath);
      if (source.alias === "hub" && ledger.links[name] &&
          verifiedOwnedLink(hub, name, ledger.links[name])) continue;
      try {
        const details = fileTree(target);
        candidates.push({
          name, key: name.toLowerCase(), source: source.alias, target,
          fingerprint: details.fingerprint, mtimeMs: details.newestMtimeMs,
          bundle: manifestForSkill(target, diagnostics),
        });
      } catch (error) {
        incomplete.push("Cannot inspect " + record.details.skillPath + ": " + error.message);
      }
    }
  }
  const familyByName = groupManifest(candidates, groups, diagnostics);
  const buckets = new Map();
  for (const entry of candidates) {
    const family = familyByName.get(entry.key);
    if (family && entry.bundle && entry.bundle.id !== family) continue;
    if (family && !entry.bundle && !(groups[family] || []).some(name => name.toLowerCase() === entry.key)) {
      continue;
    }
    const groupId = family ? "bundle:" + family : "skill:" + entry.key;
    if (!buckets.has(groupId)) buckets.set(groupId, new Map());
    const bySource = buckets.get(groupId);
    if (!bySource.has(entry.source)) bySource.set(entry.source, []);
    bySource.get(entry.source).push(entry);
  }

  const selected = [];
  const blocked = [];
  const bundles = [];
  for (const [group, bySource] of [...buckets].sort((a, b) => a[0].localeCompare(b[0], "en"))) {
    const variants = [];
    for (const [source, entries] of bySource) {
      if (group.startsWith("bundle:")) {
        const tags = new Set(entries.filter(e => e.bundle).map(e => e.bundle.version + "|" + e.bundle.commit));
        if (tags.size > 1) {
          blocked.push({ group, reason: "mixed_manifest_versions", source });
          continue;
        }
      }
      variants.push({
        group, source, entries: entries.sort((a, b) => a.key.localeCompare(b.key, "en")),
        mtimeMs: Math.max(...entries.map(e => e.mtimeMs)),
      });
    }
    if (!variants.length) continue;
    variants.sort(compareCandidates);
    // Matching resources are not proof of the same release when the
    // package manifest reports a different version/build commit.
    const signature = variant => variant.entries
      .map(e => e.key + ":" + e.fingerprint + ":" +
        (e.bundle?.version || "") + ":" + (e.bundle?.commit || "")).join("|");
    const equivalentHub = variants.find(variant =>
      variant.source === "hub" && signature(variant) === signature(variants[0]));
    const winner = equivalentHub ?? variants[0];
    bundles.push({ group, source: winner.source,
      names: winner.entries.map(e => e.name), mtimeMs: winner.mtimeMs });
    for (const entry of winner.entries) {
      selected.push({
        name: entry.name, source: entry.source, group,
        target: entry.target, mtimeMs: entry.mtimeMs,
        fingerprint: entry.fingerprint,
      });
    }
  }

  const selectedNames = new Map();
  for (const entry of selected) {
    const key = entry.name.toLowerCase();
    if (selectedNames.has(key)) {
      blocked.push({ name: entry.name, reason: "selected_name_collision",
        groups: [selectedNames.get(key).group, entry.group] });
    } else selectedNames.set(key, entry);
  }

  const actions = [];
  for (const entry of selected) {
    const name = entry.name;
    const dest = path.join(hub, name);
    const managed = ledger.links[name];
    const current = present(dest);
    const detail = { name, group: entry.group, source: entry.source, target: entry.target };
    if (managed && !verifiedOwnedLink(hub, name, managed)) {
      blocked.push({ name, reason: "managed_link_drift" });
    } else if (managed && samePath(managed.target, entry.target)) {
      actions.push({ action: "keep", ...detail });
    } else if (managed) {
      actions.push({ action: "update", ...detail });
    } else if (current) {
      if (!current.isSymbolicLink()) {
        actions.push({ action: "preserve", name, reason: "unmanaged_hub_directory" });
        if (!samePath(dest, entry.target)) {
          blocked.push({ name, reason: "unmanaged_hub_directory", desired: entry.target });
        }
      } else {
        actions.push({ action: "preserve", name, reason: "unmanaged_hub_link" });
        blocked.push({ name, reason: "unmanaged_hub_link" });
      }
    } else {
      actions.push({ action: "add", ...detail });
    }
  }
  for (const [name, item] of Object.entries(ledger.links)) {
    if (selectedNames.has(name.toLowerCase())) continue;
    if (!verifiedOwnedLink(hub, name, item)) {
      blocked.push({ name, reason: "stale_link_drift" });
    } else if (bundles.some(b => b.group === item.group)) {
      actions.push({ action: "remove", name, group: item.group, target: item.target });
    } else {
      actions.push({ action: "keep", name, group: item.group, target: item.target,
        reason: "source_missing_not_pruned" });
      diagnostics.push("Retaining managed link because no source won: " + name);
    }
  }

  return {
    schema: SCHEMA, hub, statePath, sourcesChecked: checked,
    sourceCoverageComplete: incomplete.length === 0,
    incompleteSources: incomplete, diagnostics,
    candidateCount: candidates.length, selected, bundles,
    actions: actions.sort((a, b) => a.name.localeCompare(b.name, "en")),
    blocked, canSync: blocked.length === 0 && incomplete.length === 0 &&
      diagnostics.length === 0,
  };
}

function saveLedger(file, ledger) {
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    if (present(tmp)) fs.unlinkSync(tmp);
  }
}

function requireOwnedLink(hub, name, item) {
  if (!item || !verifiedOwnedLink(hub, name, item)) {
    throw new Error("Refusing to replace non-owned or modified destination: " + name);
  }
}

function linkDir(target, dest) {
  fs.symlinkSync(target, dest, process.platform === "win32" ? "junction" : "dir");
}

export function syncSkillHub(options = {}) {
  const plan = planSkillHub(options);
  if (!plan.canSync) throw new Error("Skill Hub plan has blockers/incomplete sources; run plan first");
  const mutations = plan.actions.filter(a => ["add", "update", "remove"].includes(a.action));
  if (!mutations.length) return { applied: 0, plan };
  fs.mkdirSync(plan.hub, { recursive: true });
  fs.mkdirSync(path.dirname(plan.statePath), { recursive: true });
  const lockFile = plan.statePath + ".lock";
  const lockFd = fs.openSync(lockFile, "wx");
  let applied = 0;
  try {
    const confirmed = planSkillHub(options);
    const signature = snapshot => JSON.stringify({
      selected: snapshot.selected, actions: snapshot.actions,
    });
    if (!confirmed.canSync || signature(confirmed) !== signature(plan)) {
      throw new Error("Skill Hub sources or destinations changed during planning; retry after inspection");
    }
    const ledger = readLedger(plan.statePath, plan.hub);
    for (const action of mutations) {
      const dest = path.join(plan.hub, action.name);
      if (action.action === "add") {
        if (present(dest)) throw new Error("Destination appeared after planning: " + dest);
        linkDir(action.target, dest);
      } else if (action.action === "update") {
        requireOwnedLink(plan.hub, action.name, ledger.links[action.name]);
        const old = ledger.links[action.name].target;
        const staged = path.join(plan.hub, ".skill-hub-stage-" + crypto.randomBytes(8).toString("hex"));
        linkDir(action.target, staged);
        try {
          requireOwnedLink(plan.hub, action.name, ledger.links[action.name]);
          fs.unlinkSync(dest);
          try { fs.renameSync(staged, dest); }
          catch (error) {
            linkDir(old, dest);
            throw error;
          }
        } finally {
          if (present(staged)) fs.unlinkSync(staged);
        }
      } else {
        requireOwnedLink(plan.hub, action.name, ledger.links[action.name]);
        fs.unlinkSync(dest);
      }
      if (action.action === "remove") delete ledger.links[action.name];
      else ledger.links[action.name] = {
        target: action.target, source: action.source, group: action.group,
      };
      saveLedger(plan.statePath, ledger);
      applied += 1;
    }
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lockFile);
  }
  return { applied, plan: planSkillHub(options) };
}
