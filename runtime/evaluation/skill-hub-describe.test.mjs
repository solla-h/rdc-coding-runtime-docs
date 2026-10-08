import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeHubSelectedSkill } from "../lib/skill-hub-describe.mjs";
import { shardHubSelection } from "../lib/capability-shards.mjs";
import { planSkillHub } from "../lib/skill-hub.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rdc-hub-describe-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hub = path.join(home, ".agents", "skills");
  const root = path.join(home, "client-owned");
  fs.mkdirSync(root, { recursive: true });
  const sources = [{ alias: "mock", path: root }];
  return { home, hub, root, sources };
}

function addSkill(root, name, body = "Instruction text.") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    ["---", "name: " + name, "description: Test Skill for " + name, "---", body].join("\n"));
  return dir;
}

test("Hub worker ID re-resolves to exact selected Skill instructions without syncing", t => {
  const f = fixture(t);
  const dir = addSkill(f.root, "lark-base", "Read a Lark Base URL, then list records.");
  const p = planSkillHub(f);
  const sharded = shardHubSelection(p);
  const id = sharded.shards[0].items[0].id;
  assert.equal(id, "skill:hub:lark-base");
  const result = describeHubSelectedSkill(id, f);
  assert.equal(result.found, true);
  assert.equal(result.capability.id, id);
  assert.equal(result.capability.name, "lark-base");
  assert.equal(result.capability.source.adapter, "skill-hub-selected");
  assert.equal(result.capability.details.skillPath, path.join(dir, "SKILL.md"));
  assert.ok(result.capability.details.content.includes("list records"));
  assert.equal(result.capability.details.contentComplete, true);
  assert.equal(result.coverage.hasMore, false);
  assert.equal(fs.existsSync(f.hub), false);
});

test("Unknown and malformed virtual IDs never resolve through fuzzy search", t => {
  const f = fixture(t);
  addSkill(f.root, "one");
  for (const id of ["skill:hub:other", "skill:hub:../one", "skill:hub:one/../../secret",
    "skill:hub:one extra", "skill:hub:", "skill:hub:%2e%2e"]) {
    assert.equal(describeHubSelectedSkill(id, f).found, false, id);
  }
});

test("Instructions are bounded and readFullPath is supplied only for truncated content", t => {
  const f = fixture(t);
  const dir = addSkill(f.root, "long", "X".repeat(230));
  const result = describeHubSelectedSkill("skill:hub:long", {
    ...f, maxSkillContentChars: 100,
  });
  assert.equal(result.found, true);
  assert.equal(result.capability.details.content.length, 100);
  assert.equal(result.capability.details.contentComplete, false);
  assert.equal(result.capability.details.readFullPath, path.join(dir, "SKILL.md"));
});

test("Blocked Hub plan prevents exposing a different unmanaged version", t => {
  const f = fixture(t);
  addSkill(f.hub, "same", "Unmanaged, older content.");
  addSkill(f.root, "same", "Newer version different body.");
  const file = path.join(f.root, "same", "SKILL.md");
  fs.utimesSync(file, new Date(2200000000000), new Date(2200000000000));
  const result = describeHubSelectedSkill("skill:hub:same", f);
  assert.equal(result.found, false);
  assert.equal(result.reason, "hub_plan_incomplete_or_blocked");
  assert.ok(result.blocked.length > 0);
});
