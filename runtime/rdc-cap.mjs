#!/usr/bin/env node
import path from "node:path";
import {
  CAPABILITY_RUNTIME_VERSION,
  buildContextSnapshot,
  describeCapability,
  findCapabilityMatches,
  renderContextMarkdown,
  renderDescribeMarkdown,
  renderFindMarkdown,
} from "./lib/capabilities.mjs";

function usage() {
  return [
    "Usage:",
    "  rdc-cap context [--workspace <path>] [--query <task>] [--json]",
    "  rdc-cap find <exact-name-or-id> [--workspace <path>] [--json]",
    "  rdc-cap describe <capability-id> [--workspace <path>] [--json]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const json = args.includes("--json");
  const takeOption = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return null;
    if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const workspaceRaw = takeOption("--workspace");
  const queryOption = takeOption("--query");
  const filtered = args.filter(value => value !== "--json");
  const command = filtered.shift();
  return {
    command,
    rest: filtered,
    json,
    workspace: workspaceRaw ? path.resolve(workspaceRaw) : null,
    queryOption,
  };
}

function print(value, asJson, renderer) {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${renderer(value)}\n`);
}

function main() {
  if (process.argv.length === 3 && ["--version", "-V"].includes(process.argv[2])) {
    console.log("rdc-cap " + CAPABILITY_RUNTIME_VERSION);
    return;
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || ["-h", "--help", "help"].includes(parsed.command)) {
    console.log(usage());
    return;
  }

  if (parsed.command === "context") {
    if (parsed.rest.length) throw new Error(`unexpected arguments: ${parsed.rest.join(" ")}`);
    const result = buildContextSnapshot({
      workspace: parsed.workspace,
      query: parsed.queryOption || "",
    });
    print(result, parsed.json, renderContextMarkdown);
    return;
  }

  if (parsed.command === "find") {
    const lookup = parsed.rest.join(" ").trim();
    if (!lookup) throw new Error("find requires an exact capability name or id");
    const result = findCapabilityMatches(lookup, { workspace: parsed.workspace });
    print(result, parsed.json, renderFindMarkdown);
    return;
  }

  if (parsed.command === "describe") {
    if (parsed.rest.length !== 1) throw new Error("describe requires exactly one capability id");
    const result = describeCapability(parsed.rest[0], { workspace: parsed.workspace });
    print(result, parsed.json, renderDescribeMarkdown);
    if (!result.found) process.exitCode = 3;
    return;
  }

  throw new Error(`unknown command: ${parsed.command}`);
}

try {
  main();
} catch (error) {
  console.error(`rdc-cap error: ${error?.message || String(error)}`);
  console.error(usage());
  process.exitCode = 2;
}
