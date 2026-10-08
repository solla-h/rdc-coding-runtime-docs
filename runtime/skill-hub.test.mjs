import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planSkillHub, syncSkillHub } from "./lib/skill-hub.mjs";
import { shardCapabilities, shardHubSelection } from "./lib/capability-shards.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "skill-hub.mjs");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-skill-hub-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hub = path.join(home, ".agents", "skills");
  const a = path.join(home, "a");
  const b = path.join(home, "b");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  return { home, hub, a, b, sources: [
    { alias: "a", path: a }, { alias: "b", path: b },
  ] };
}

function skill(root, name, version, mtime = 100, bundle = null) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  const filename = path.join(folder, "SKILL.md");
  fs.writeFileSync(filename, [
    "---", "name: " + name, "description: Version " + version, "---",
    "Instructions for " + name + ": " + version, "",
  ].join("\n"));
  const date = new Date(mtime * 1000);
  fs.utimesSync(filename, date, date);
  if (bundle) {
    fs.writeFileSync(path.join(folder, "." + bundle.id + "-install.json"),
      JSON.stringify({ installedVersion: bundle.version, buildCommit: bundle.commit }));
  }
  return folder;
}

function plan(f, opts = {}) {
  return planSkillHub({ home: f.home, hub: f.hub, sources: f.sources, ...opts });
}
function sync(f, opts = {}) {
  return syncSkillHub({ home: f.home, hub: f.hub, sources: f.sources, ...opts });
}
function actual(p) {
  return fs.realpathSync(p).toLowerCase();
}

test("plan is read-only, newest different Skill content wins, sync is idempotent", t => {
  const f = fixture(t);
  skill(f.a, "demo", "old", 100);
  const best = skill(f.b, "demo", "new", 200);
  const before = plan(f);
  assert.equal(before.canSync, true);
  assert.equal(before.selected.length, 1);
  assert.equal(before.actions[0].action, "add");
  assert.equal(before.actions[0].target, best);
  assert.equal(fs.existsSync(f.hub), false);
  assert.equal(fs.existsSync(path.join(f.home, ".rdc")), false);
  const first = sync(f);
  assert.equal(first.applied, 1);
  assert.equal(actual(path.join(f.hub, "demo")), actual(best));
  assert.equal(sync(f).applied, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.home, ".rdc", "skill-hub", "links.json"), "utf8"));
  assert.equal(ledger.links.demo.target, best);
});

test("identical full resources favor a user-owned hub directory despite newer source timestamps", t => {
  const f = fixture(t);
  const own = skill(f.hub, "same", "v1", 100);
  const other = skill(f.a, "same", "v1", 200);
  assert.notEqual(actual(own), actual(other));
  const p = plan(f);
  assert.equal(p.canSync, true);
  assert.deepEqual(p.blocked, []);
  assert.equal(p.selected[0].source, "hub");
  assert.deepEqual(p.actions.map(a => a.action), ["preserve"]);
  assert.equal(sync(f).applied, 0);
  assert.equal(fs.lstatSync(own).isDirectory(), true);
});

test("an unowned local directory is never removed to make a newer version win", t => {
  const f = fixture(t);
  const old = skill(f.hub, "demo", "old", 100);
  skill(f.a, "demo", "new", 200);
  const p = plan(f);
  assert.equal(p.canSync, false);
  assert.equal(p.blocked[0].reason, "unmanaged_hub_directory");
  assert.throws(() => sync(f), /blockers/);
  assert.equal(fs.lstatSync(old).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(old, "SKILL.md"), "utf8").includes("old"), true);
});

test("a managed link is retargeted only when it still matches the ledger", t => {
  const f = fixture(t);
  const old = skill(f.a, "swap", "old", 200);
  const next = skill(f.b, "swap", "new", 100);
  assert.equal(sync(f).applied, 1);
  assert.equal(actual(path.join(f.hub, "swap")), actual(old));
  const name = path.join(next, "SKILL.md");
  fs.utimesSync(name, new Date(300000), new Date(300000));
  const p = plan(f);
  assert.deepEqual(p.actions.map(a => a.action), ["update"]);
  assert.equal(sync(f).applied, 1);
  assert.equal(actual(path.join(f.hub, "swap")), actual(next));
  assert.equal(sync(f).applied, 0);
});

test("ledger ownership is not sufficient if the actual link was replaced", t => {
  const f = fixture(t);
  skill(f.a, "safe", "a", 100);
  const different = skill(f.b, "safe", "b", 200);
  assert.equal(sync(f).applied, 1);
  const dest = path.join(f.hub, "safe");
  fs.unlinkSync(dest);
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "user.txt"), "must-not-delete");
  const p = plan(f);
  assert.equal(p.canSync, false);
  assert.equal(p.blocked[0].reason, "managed_link_drift");
  assert.throws(() => sync(f), /blockers/);
  assert.equal(fs.readFileSync(path.join(dest, "user.txt"), "utf8"), "must-not-delete");
  assert.equal(fs.existsSync(different), true);
});

test("a versioned bundle selects all members from a single source", t => {
  const f = fixture(t);
  const metaA = { id: "suite", version: "1.0", commit: "aaa" };
  const metaB = { id: "suite", version: "2.0", commit: "bbb" };
  skill(f.a, "suite-main", "a-main", 110, metaA);
  skill(f.a, "suite-helper", "a-helper", 100, metaA);
  skill(f.b, "suite-main", "b-main", 300, metaB);
  skill(f.b, "suite-helper", "b-helper", 10, metaB);
  const p = plan(f);
  assert.equal(p.canSync, true);
  assert.equal(p.bundles.length, 1);
  assert.equal(p.bundles[0].source, "b");
  assert.deepEqual(new Set(p.selected.map(x => x.source)), new Set(["b"]));
  assert.equal(sync(f).applied, 2);
  assert.equal(actual(path.join(f.hub, "suite-main")), actual(path.join(f.b, "suite-main")));
  assert.equal(actual(path.join(f.hub, "suite-helper")), actual(path.join(f.b, "suite-helper")));
});

test("bundle upgrade removes owned members absent from the new release", t => {
  const f = fixture(t);
  const a = { id: "suite", version: "1", commit: "old" };
  const b = { id: "suite", version: "2", commit: "new" };
  for (const name of ["suite-a", "suite-b", "suite-c"]) skill(f.a, name, "v1", 150, a);
  assert.equal(sync(f).applied, 3);
  for (const name of ["suite-a", "suite-b"]) skill(f.b, name, "v2", 250, b);
  const p = plan(f);
  assert.equal(p.canSync, true);
  assert.deepEqual(p.actions.filter(x => x.action === "remove").map(x => x.name), ["suite-c"]);
  assert.equal(sync(f).applied, 3);
  assert.equal(fs.existsSync(path.join(f.hub, "suite-c")), false);
  assert.equal(actual(path.join(f.hub, "suite-a")), actual(path.join(f.b, "suite-a")));
});

test("different build commits within one source bundle block sync", t => {
  const f = fixture(t);
  skill(f.a, "suite-a", "one", 10, { id: "suite", version: "1", commit: "abc" });
  skill(f.a, "suite-b", "two", 10, { id: "suite", version: "2", commit: "def" });
  const p = plan(f);
  assert.equal(p.canSync, false);
  assert.ok(p.blocked.some(x => x.reason === "mixed_manifest_versions"));
  assert.throws(() => sync(f), /blockers/);
});

test("explicit groups work for skills with no install manifest", t => {
  const f = fixture(t);
  for (const name of ["north", "south"]) {
    skill(f.a, name, "old", 10);
    skill(f.b, name, "new", name === "north" ? 100 : 1);
  }
  const p = plan(f, { groups: { region: ["north", "south"] } });
  assert.equal(p.canSync, true);
  assert.equal(p.bundles[0].group, "bundle:region");
  assert.deepEqual(new Set(p.selected.map(x => x.source)), new Set(["b"]));
});

test("unregistered external symlink still triggers incomplete coverage", t => {
  const f = fixture(t);
  const outside = path.join(f.home, "outside");
  skill(outside, "unknown", "secret");
  const link = path.join(f.a, "outside-link");
  try { fs.symlinkSync(path.join(outside, "unknown"), link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { t.skip("Link creation unsupported: " + error.message); return; }
  const p = plan(f);
  assert.equal(p.canSync, false);
  assert.ok(p.incompleteSources.some(x => x.includes("outside allowed roots")));
});

test("default source discovery includes only enabled, installed Claude plugin skills", t => {
  const f = fixture(t);
  const enabledRoot = path.join(f.home, "plugins", "enabled");
  const disabledRoot = path.join(f.home, "plugins", "disabled");
  skill(path.join(enabledRoot, "skills"), "enabled-skill", "one");
  skill(path.join(disabledRoot, "skills"), "disabled-skill", "one");
  const registryDir = path.join(f.home, ".claude", "plugins");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, "installed_plugins.json"), JSON.stringify({
    plugins: {
      "enabled@example": [{ installPath: enabledRoot }],
      "disabled@example": [{ installPath: disabledRoot }],
    },
  }));
  fs.writeFileSync(path.join(f.home, ".claude", "settings.json"), JSON.stringify({
    enabledPlugins: { "enabled@example": true, "disabled@example": false },
  }));
  const p = planSkillHub({ home: f.home });
  assert.ok(p.sourcesChecked.some(s => s.startsWith("claude-plugin-")));
  assert.ok(p.selected.some(s => s.name === "enabled-skill"));
  assert.ok(!p.selected.some(s => s.name === "disabled-skill"));
});

test("CLI plan and sync accept explicit isolated sources and JSON output", t => {
  const f = fixture(t);
  skill(f.a, "cli-demo", "v1");
  const base = ["--home", f.home, "--source", "a=" + f.a, "--json"];
  const view = spawnSync(process.execPath, [CLI, "plan", ...base], { encoding: "utf8" });
  assert.equal(view.status, 0, view.stderr);
  assert.equal(JSON.parse(view.stdout).selected.length, 1);
  assert.equal(fs.existsSync(f.hub), false);
  const apply = spawnSync(process.execPath, [CLI, "sync", ...base], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).applied, 1);
  assert.ok(fs.lstatSync(path.join(f.hub, "cli-demo")).isSymbolicLink());
});


test("shard planner covers 5000 descriptions exactly once with deterministic 256 KiB groups", () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({
    id: "skill:hub:skill-" + String(i).padStart(5, "0"),
    description: "Local tool instructions: " + String(i).padStart(5, "0") + "x".repeat(600),
    name: "skill-" + i,
    source: "fixture",
  }));
  const first = shardCapabilities(items, { parallelism: 4 });
  const reordered = shardCapabilities([...items].reverse(), { parallelism: 4 });
  assert.equal(first.coverageComplete, true);
  assert.equal(first.itemCount, 5000);
  assert.ok(first.shardCount > 1);
  assert.equal(first.waves, Math.ceil(first.shardCount / 4));
  assert.deepEqual(first.oversizedShards, []);
  assert.ok(first.shards.every(shard => shard.bytes <= 256 * 1024));
  assert.equal(first.inputDigest, reordered.inputDigest);
  assert.deepEqual(first.shards, reordered.shards);
});

test("oversized single metadata entry is kept intact and explicitly marked", () => {
  const p = shardCapabilities([{ id: "very-long", description: "x".repeat(5000) }], {
    targetBytes: 1024, parallelism: 1,
  });
  assert.equal(p.coverageComplete, true);
  assert.deepEqual(p.oversizedShards, ["shard-0001"]);
  assert.equal(p.shards[0].items[0].description.length, 5000);
  assert.throws(() => shardCapabilities([{ id: "duplicated", description: "a" },
    { id: "duplicated", description: "b" }]), /Duplicate capability id/);
});

test("shard can materialize complete metadata from a dry-run hub selection", t => {
  const f = fixture(t);
  skill(f.a, "demo-a", "one", 10);
  skill(f.a, "demo-b", "two", 20);
  const selected = shardHubSelection(plan(f), { parallelism: 2, targetBytes: 4096 });
  assert.equal(selected.itemCount, 2);
  assert.ok(selected.shards[0].items[0].id.startsWith("skill:hub:"));
  assert.ok(selected.shards[0].items.every(x => x.description.length > 0));
  assert.equal(fs.existsSync(f.hub), false);
  const fromCli = spawnSync(process.execPath, [CLI, "shard", "--json",
    "--home", f.home, "--source", "a=" + f.a, "--parallelism", "2",
    "--target-bytes", "4096"], { encoding: "utf8" });
  assert.equal(fromCli.status, 0, fromCli.stderr);
  assert.equal(JSON.parse(fromCli.stdout).inputDigest, selected.inputDigest);
  assert.equal(fs.existsSync(f.hub), false);
});


test("same Skill resources but a different declared bundle commit is not collapsed", t => {
  const f = fixture(t);
  const hub = skill(f.hub, "suite-a", "same", 10, {
    id: "suite", version: "1", commit: "previous",
  });
  skill(f.a, "suite-a", "same", 100, {
    id: "suite", version: "2", commit: "newer",
  });
  const p = plan(f);
  assert.equal(p.selected[0].source, "a");
  assert.equal(p.canSync, false);
  assert.ok(p.blocked.some(b => b.reason === "unmanaged_hub_directory"));
  assert.equal(fs.lstatSync(hub).isDirectory(), true);
});


test("invalid package release metadata blocks sync instead of splitting a bundle", t => {
  const f = fixture(t);
  const folder = skill(f.a, "broken-package", "v1");
  fs.writeFileSync(path.join(folder, ".suite-install.json"), "{invalid");
  const p = plan(f);
  assert.equal(p.canSync, false);
  assert.ok(p.diagnostics.some(x => x.includes("invalid install manifest")));
  assert.throws(() => sync(f), /blockers/);
  assert.equal(fs.existsSync(f.hub), false);
});
