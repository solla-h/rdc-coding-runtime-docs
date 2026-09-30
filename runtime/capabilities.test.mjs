import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildContextSnapshot,
  defaultSkillRoots,
  describeCapability,
  discoverProjectRecords,
  discoverSkillRecords,
  findCapabilityMatches,
  parseSkillFrontmatter,
  renderContextMarkdown,
} from "./lib/capabilities.mjs";

const NOW = "2026-09-29T12:00:00.000Z";

function tempDir(t, prefix = "rdc-cap-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(root, relative, name, description, body = "") {
  const dir = path.join(root, relative);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---
name: ${name}
description: >
  ${description}
---
${body || "# " + name + "\n\nInstructions."}
`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), text, "utf8");
  return path.join(dir, "SKILL.md");
}

test("parses folded multiline Skill frontmatter", () => {
  const parsed = parseSkillFrontmatter(`---
name: demo-skill
description: >
  First line.
  Second line.
bins: [demo, "demo-cli"]
---
body`);
  assert.equal(parsed.name, "demo-skill");
  assert.equal(parsed.description, "First line. Second line.");
  assert.deepEqual(parsed.bins, ["demo", "demo-cli"]);
});

test("workspace Skill roots require explicit project instruction adoption", t => {
  const workspace = tempDir(t);
  fs.mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
  let roots = defaultSkillRoots({ home: path.join(workspace, "home"), workspace });
  assert.equal(roots.some(root => root.alias === "workspace-agents"), false);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Use .agents/skills for project Skills.\n");
  roots = defaultSkillRoots({ home: path.join(workspace, "home"), workspace });
  assert.equal(roots.some(root => root.alias === "workspace-agents"), true);
  assert.equal(roots.some(root => root.alias === "workspace-pi"), false);
});

test("canonical path deduplicates the same Skill reached through two roots", t => {
  const dir = tempDir(t);
  const root = path.join(dir, "root");
  writeSkill(root, "demo", "demo-skill", "Canonical target.");
  const alias = path.join(dir, "alias");
  try {
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code || error.message}`);
    return;
  }
  const result = discoverSkillRecords({
    skillRoots: [
      { alias: "one", path: root },
      { alias: "two", path: alias },
    ],
    now: NOW,
  });
  assert.equal(result.records.length, 1);
});

test("links outside an allowed Skill root do not expand discovery", t => {
  const dir = tempDir(t);
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  writeSkill(root, "inside", "inside-skill", "Inside.");
  writeSkill(outside, "escape", "outside-skill", "Outside.");
  fs.mkdirSync(root, { recursive: true });
  const link = path.join(root, "escape-link");
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code || error.message}`);
    return;
  }
  const result = discoverSkillRecords({
    skillRoots: [{ alias: "bounded", path: root }],
    now: NOW,
  });
  assert.deepEqual(result.records.map(record => record.name), ["inside-skill"]);
  assert.match(result.incompleteSources.join("\n"), /skipped link outside allowed roots/i);
});

test("same-name Skills from distinct sources remain distinct and ambiguous", t => {
  const dir = tempDir(t);
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  writeSkill(a, "dup", "dup-skill", "First source.");
  writeSkill(b, "dup", "dup-skill", "Second source.");
  const result = discoverSkillRecords({
    skillRoots: [{ alias: "a", path: a }, { alias: "b", path: b }],
    now: NOW,
  });
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].id, result.records[1].id);
});

test("context is an unranked catalog and does not semantically filter by query", t => {
  const home = tempDir(t);
  const root = path.join(home, "skills");
  writeSkill(root, "review", "review", "Review source code changes.");
  writeSkill(root, "lark-markdown", "lark-markdown", "Work with Feishu/Lark Markdown content.");
  const snapshot = buildContextSnapshot({
    home,
    query: "preview this local Markdown book",
    skillRoots: [{ alias: "fixture", path: root }],
    now: NOW,
  });
  assert.equal(snapshot.semanticSelectionPerformed, false);
  assert.deepEqual(snapshot.capabilities.map(item => item.name), ["lark-markdown", "review"]);
  assert.equal(snapshot.capabilities.some(item => "score" in item), false);
});

test("package scripts are declared evidence, not runtime availability", t => {
  const workspace = tempDir(t);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.0.0",
    scripts: { test: "vitest run", preview: "vite preview" },
  }), "utf8");
  const result = discoverProjectRecords({ workspace, now: NOW });
  const testRecord = result.records.find(record => record.name === "package script: test");
  assert.ok(testRecord);
  assert.equal(testRecord.details.command, "pnpm run test");
  assert.deepEqual(testRecord.observation.facts, ["project_script_declared"]);
  assert.ok(testRecord.observation.notChecked.includes("dependencies_installed"));
  assert.match(testRecord.summary, /evidence-dependent/);
});

test("single-token find performs an exact command resolution", t => {
  const home = tempDir(t);
  const result = findCapabilityMatches("docsify", {
    home,
    skillRoots: [],
    resolver: name => name === "docsify" ? ["C:\\Tools\\docsify.cmd"] : [],
    now: NOW,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].name, "docsify");
  assert.deepEqual(result.matches[0].observation.facts, ["command_resolves"]);
  assert.ok(result.matches[0].observation.notChecked.includes("runtime_success"));
});

test("capability IDs stay stable when Skill content changes in place", t => {
  const root = tempDir(t);
  const skillPath = writeSkill(root, "stable", "stable-skill", "Version one.");
  const first = discoverSkillRecords({
    skillRoots: [{ alias: "root", path: root }],
    now: NOW,
  }).records[0];
  fs.writeFileSync(skillPath, `---
name: stable-skill
description: Version two.
---
updated body
`, "utf8");
  const second = discoverSkillRecords({
    skillRoots: [{ alias: "root", path: root }],
    now: NOW,
  }).records[0];
  assert.equal(first.id, second.id);
  assert.notEqual(first.summary, second.summary);
});
test("context JSON and Markdown honor a small byte budget", t => {
  const home = tempDir(t);
  const root = path.join(home, ".agents", "skills");
  for (let i = 0; i < 20; i += 1) {
    writeSkill(root, `skill-${i}`, `skill-${i}`, "x".repeat(900));
  }
  const snapshot = buildContextSnapshot({
    home,
    skillRoots: [{ alias: "agents", path: root }],
    maxBytes: 4096,
    maxItems: 12,
    now: NOW,
  });
  const json = JSON.stringify(snapshot);
  const markdown = renderContextMarkdown(snapshot, 4096);
  assert.ok(Buffer.byteLength(json, "utf8") <= 4096);
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 4096);
  assert.equal(snapshot.coverage.hasMore, true);
});

test("describe marks oversized Skill instructions as incomplete", t => {
  const home = tempDir(t);
  const root = path.join(home, "skills");
  writeSkill(root, "large", "large-skill", "Large Skill.", "z".repeat(12000));
  const records = discoverSkillRecords({
    skillRoots: [{ alias: "fixture", path: root }],
    now: NOW,
  }).records;
  const result = describeCapability(records[0].id, {
    home,
    skillRoots: [{ alias: "fixture", path: root }],
    maxSkillContentChars: 1000,
    now: NOW,
  });
  assert.equal(result.found, true);
  assert.equal(result.capability.details.contentComplete, false);
  assert.equal(result.capability.details.content.length, 1000);
  assert.equal(result.capability.details.readFullPath, records[0].details.skillPath);
});

test("discovery does not read router config or create derived router files", t => {
  const home = tempDir(t);
  const router = path.join(home, ".rdc", "how-to-use");
  fs.mkdirSync(router, { recursive: true });
  const configPath = path.join(router, "config.json");
  fs.writeFileSync(configPath, '{"apiKey":"DO_NOT_READ_OR_CHANGE"}\n', "utf8");
  fs.mkdirSync(path.join(home, ".rdc"), { recursive: true });
  fs.writeFileSync(path.join(home, ".rdc", "MACHINE_CONTEXT.md"), "# Machine\n- Node present\n", "utf8");
  const before = fs.readFileSync(configPath, "utf8");
  buildContextSnapshot({ home, skillRoots: [], now: NOW });
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  assert.equal(fs.existsSync(path.join(router, "pi-agent", "models.json")), false);
  assert.equal(fs.existsSync(path.join(router, "pi-agent", "settings.json")), false);
});
test("malformed Skill metadata is reported as incomplete coverage", t => {
  const root = tempDir(t);
  const dir = path.join(root, "broken");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: missing name\n---\n", "utf8");
  const result = discoverSkillRecords({
    skillRoots: [{ alias: "fixture", path: root }],
    now: NOW,
  });
  assert.equal(result.records.length, 0);
  assert.match(result.incompleteSources.join("\n"), /missing valid name/i);
});

test("MACHINE_CONTEXT secret-like lines are excluded from context output", t => {
  const home = tempDir(t);
  const rdc = path.join(home, ".rdc");
  fs.mkdirSync(rdc, { recursive: true });
  fs.writeFileSync(path.join(rdc, "MACHINE_CONTEXT.md"), [
    "# Machine",
    "- Node present",
    "- apiKey: SHOULD_NOT_APPEAR",
    "- access_token: SHOULD_NOT_APPEAR",
  ].join("\n"), "utf8");
  const snapshot = buildContextSnapshot({ home, skillRoots: [], now: NOW });
  assert.match(snapshot.machineHints, /Node present/);
  assert.doesNotMatch(snapshot.machineHints, /SHOULD_NOT_APPEAR/);
});

test("workspace switch changes project-scoped command identity", t => {
  const root = tempDir(t);
  const one = path.join(root, "one");
  const two = path.join(root, "two");
  for (const workspace of [one, two]) {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
      scripts: { test: "node test.mjs" },
    }), "utf8");
  }
  const first = discoverProjectRecords({ workspace: one, now: NOW }).records[0];
  const second = discoverProjectRecords({ workspace: two, now: NOW }).records[0];
  assert.notEqual(first.id, second.id);
  assert.equal(first.details.cwd, one);
  assert.equal(second.details.cwd, two);
});

test("how-to-use explicit offline mode needs no Router config or network", t => {
  const home = tempDir(t);
  const root = path.join(home, ".agents", "skills");
  writeSkill(root, "demo", "demo-capability", "Demo local capability.");
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const run = spawnSync(process.execPath, [
    path.join(runtimeDir, "how-to-use.mjs"),
    "--offline",
    "read-only no-network use demo-capability",
  ], {
    encoding: "utf8",
    cwd: runtimeDir,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /RDC capability context/);
  assert.match(run.stdout, /Capability catalog \(unranked\)/);
  assert.match(run.stdout, /demo-capability/);
  assert.match(run.stderr, /backend=offline-catalog/);
  assert.match(run.stderr, /semantic_selection=false/);
  assert.equal(fs.existsSync(path.join(home, ".rdc", "how-to-use", "pi-agent", "models.json")), false);
});

test("normal how-to-use still requires a validated Router and stays non-mutating on failure", t => {
  const home = tempDir(t);
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const run = spawnSync(process.execPath, [
    path.join(runtimeDir, "how-to-use.mjs"),
    "use demo-capability",
  ], {
    encoding: "utf8",
    cwd: runtimeDir,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 10000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Pi backend is not verified/);
  assert.equal(fs.existsSync(path.join(home, ".rdc", "how-to-use")), false);
});

test("describe re-resolves a PATH command from its stable capability id", t => {
  const home = tempDir(t);
  const resolver = name => name === "docsify" ? ["C:\\Tools\\docsify.cmd"] : [];
  const found = findCapabilityMatches("docsify", {
    home,
    skillRoots: [],
    resolver,
    now: NOW,
  });
  const result = describeCapability(found.matches[0].id, {
    home,
    skillRoots: [],
    resolver,
    now: NOW,
  });
  assert.equal(result.found, true);
  assert.equal(result.capability.name, "docsify");
  assert.equal(result.capability.details.command, "docsify");
  assert.deepEqual(result.capability.observation.facts, ["command_resolves"]);
});

test("natural-language find does not guess CLI candidates", t => {
  const home = tempDir(t);
  const seen = [];
  const result = findCapabilityMatches(
    "read-only no-network determine whether docsify is installed; do not modify anything",
    {
      home,
      skillRoots: [],
      resolver: name => {
        seen.push(name);
        return [];
      },
      now: NOW,
    },
  );
  assert.deepEqual(seen, []);
  assert.deepEqual(result.matches, []);
  assert.equal(result.semanticSelectionPerformed, false);
});

test("constraint prose is not interpreted by deterministic context/find", t => {
  const home = tempDir(t);
  const root = path.join(home, "skills");
  writeSkill(root, "lark-note", "lark-note",
    "Read a Lark note by note_id and inspect its transcript.");
  writeSkill(root, "codebase-design", "codebase-design",
    "Design or improve a codebase module.");
  const query = "read-only no-network determine whether docsify is installed; do not modify anything";
  const snapshot = buildContextSnapshot({
    home,
    query,
    skillRoots: [{ alias: "fixture", path: root }],
    resolver: () => [],
    now: NOW,
  });
  assert.equal(snapshot.semanticSelectionPerformed, false);
  assert.deepEqual(snapshot.capabilities.map(item => item.name), ["codebase-design", "lark-note"]);
  assert.equal(snapshot.coverage.incompleteSources.length, 0);
  assert.equal(snapshot.coverage.hasMore, false);

  const found = findCapabilityMatches(query, {
    home,
    skillRoots: [{ alias: "fixture", path: root }],
    resolver: () => [],
    now: NOW,
  });
  assert.deepEqual(found.matches, []);
});

test("package manager stays unknown when no declaration or supported lockfile exists", t => {
  const workspace = tempDir(t);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    scripts: { test: "node test.mjs" },
  }), "utf8");
  const result = discoverProjectRecords({ workspace, now: NOW });
  assert.match(result.evidence.map(item => item.fact).join("\n"), /package manager not determined/);
  const record = result.records.find(item => item.name === "package script: test");
  assert.ok(record);
  assert.equal(record.details.command, null);
  assert.equal(record.details.scriptName, "test");
});

test("exact Skill lookup preserves same-name ambiguity instead of scoring a winner", t => {
  const home = tempDir(t);
  const a = path.join(home, "a");
  const b = path.join(home, "b");
  writeSkill(a, "dup", "dup-skill", "First.");
  writeSkill(b, "dup", "dup-skill", "Second.");
  const result = findCapabilityMatches("dup-skill", {
    home,
    skillRoots: [{ alias: "a", path: a }, { alias: "b", path: b }],
    now: NOW,
  });
  assert.equal(result.semanticSelectionPerformed, false);
  assert.equal(result.matches.length, 2);
  assert.notEqual(result.matches[0].id, result.matches[1].id);
});


test("production advisor delegates semantic selection and evidence iteration to one native Pi agent loop", () => {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(runtimeDir, "how-to-use.mjs"), "utf8");
  assert.match(source, /advisorTools:true/);
  assert.match(source, /agent_loop=native/);
  assert.match(source, /wait_for_pid=true/);
  const ownershipMarker = source.indexOf("[how-to-use] advisor_running backend=pi");
  const blockingPiRun = source.indexOf("const run = piRun(advisorPrompt");
  assert.ok(ownershipMarker >= 0, "advisor ownership marker must exist");
  assert.ok(blockingPiRun > ownershipMarker, "ownership marker must be emitted before the blocking Pi run");
  assert.match(source, /--extension/);
  assert.match(source, /capability_context,capability_describe,command_resolve/);
  for (const removed of [
    "routePrompt(",
    "parseJsonObject(",
    "normalizeRoute(",
    "collectEvidence(",
    "finalPrompt(",
    "semanticAdvisor(",
    "modelCall(",
  ]) {
    assert.equal(source.includes(removed), false, removed + " should not remain in production source");
  }
});

test("Pi advisor extension exposes only narrow read-only capability evidence tools", () => {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(runtimeDir, "pi-capability-tools.ts"), "utf8");
  assert.match(source, /name: "capability_context"/);
  assert.match(source, /name: "capability_describe"/);
  assert.match(source, /name: "command_resolve"/);
  assert.match(source, /buildContextSnapshot/);
  assert.match(source, /describeCapability/);
  assert.match(source, /findCapabilityMatches/);
  assert.equal(/spawnSync|execFile|child_process|registerCommand|registerProvider/.test(source), false);
});
