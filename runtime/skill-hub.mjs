#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planSkillHub, syncSkillHub, ledgerPath } from "./lib/skill-hub.mjs";
import { CAPABILITY_RUNTIME_VERSION } from "./lib/capabilities.mjs";
import { shardHubSelection, DEFAULT_SHARD_BYTES, DEFAULT_PARALLELISM } from "./lib/capability-shards.mjs";

function usage() {
  return [
    "Usage:",
    "  node runtime/skill-hub.mjs plan [--json] [--home PATH] [--hub PATH]",
    "    [--state PATH] [--source ALIAS=PATH]... [--groups FILE]",
    "  node runtime/skill-hub.mjs sync [same options]",
    "  node runtime/skill-hub.mjs shard [same options] [--target-bytes 262144] [--parallelism 4]",
    "",
    "plan and shard are read-only. sync changes only Skill Hub-owned links and its ledger.",
    "If --source is given, it replaces default external sources (hub is always included).",
    "--groups accepts JSON {\"bundles\":{\"family\":[\"skill-a\",\"skill-b\"]}}.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  let home = os.homedir();
  let hub = null;
  let statePath = null;
  let sources = null;
  let groupFile = null;
  let json = false;
  let targetBytes = DEFAULT_SHARD_BYTES;
  let parallelism = DEFAULT_PARALLELISM;
  while (args.length) {
    const key = args.shift();
    if (key === "--json") { json = true; continue; }
    if (!["--home", "--hub", "--state", "--source", "--groups", "--target-bytes", "--parallelism"].includes(key)) {
      throw new Error("Unexpected argument: " + key);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(key + " requires a value");
    if (key === "--home") home = path.resolve(value);
    if (key === "--hub") hub = path.resolve(value);
    if (key === "--state") statePath = path.resolve(value);
    if (key === "--groups") groupFile = path.resolve(value);
    if (key === "--target-bytes") targetBytes = Number(value);
    if (key === "--parallelism") parallelism = Number(value);
    if (key === "--source") {
      const split = value.indexOf("=");
      if (split < 1) throw new Error("--source needs ALIAS=PATH");
      if (sources === null) sources = [];
      sources.push({ alias: value.slice(0, split), path: path.resolve(value.slice(split + 1)) });
    }
  }
  let groups = {};
  if (groupFile) {
    const raw = JSON.parse(fs.readFileSync(groupFile, "utf8"));
    if (!raw || typeof raw.bundles !== "object" || Array.isArray(raw.bundles)) {
      throw new Error("--groups requires a JSON object with bundles");
    }
    groups = raw.bundles;
  }
  return { command, json, targetBytes, parallelism, options: {
    home, hub: hub ?? path.join(home, ".agents", "skills"),
    statePath: statePath ?? ledgerPath(home), sources, groups,
  } };
}

function render(result) {
  const plan = result.plan ?? result;
  const lines = [
    "Skill Hub " + (result.plan ? "sync" : "plan"),
    "hub: " + plan.hub,
    "sources: " + plan.sourcesChecked.join(", "),
    "candidates: " + plan.candidateCount,
    "selected: " + plan.selected.length,
    "bundles: " + plan.bundles.filter(b => b.group.startsWith("bundle:")).length,
    "actions: " + ["add", "update", "remove", "keep", "preserve"]
      .map(kind => kind + "=" + plan.actions.filter(a => a.action === kind).length).join(", "),
    "sync_allowed: " + plan.canSync,
  ];
  if (result.plan) lines.push("applied: " + result.applied);
  for (const action of plan.actions.filter(a => ["add", "update", "remove", "preserve"].includes(a.action))) {
    lines.push(action.action + ": " + action.name + (action.target ? " <- " + action.target : ""));
  }
  for (const issue of plan.blocked) lines.push("BLOCKED: " + JSON.stringify(issue));
  for (const issue of plan.incompleteSources) lines.push("INCOMPLETE: " + issue);
  for (const issue of plan.diagnostics) lines.push("INFO: " + issue);
  return lines.join("\n");
}

try {
  const { command, json, options, targetBytes, parallelism } = parseArgs(process.argv.slice(2));
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
  } else if (["-V", "--version"].includes(command)) {
    console.log("skill-hub " + CAPABILITY_RUNTIME_VERSION);
  } else if (command === "plan" || command === "sync") {
    const result = command === "plan" ? planSkillHub(options) : syncSkillHub(options);
    console.log(json ? JSON.stringify(result, null, 2) : render(result));
  } else if (command === "shard") {
    const result = shardHubSelection(planSkillHub(options), { targetBytes, parallelism });
    const brief = ["Skill Hub shards: " + result.shardCount,
      "items: " + result.itemCount,
      "parallelism: " + result.parallelism,
      "waves: " + result.waves,
      "coverage_complete: " + result.coverageComplete,
      ...result.shards.map(s => s.id + ": " + s.count + " items, " + s.bytes + " bytes")].join("\n");
    console.log(json ? JSON.stringify(result, null, 2) : brief);
  } else throw new Error("Unknown command: " + command);
} catch (error) {
  console.error("skill-hub error: " + (error?.message || String(error)));
  process.exitCode = 2;
}
