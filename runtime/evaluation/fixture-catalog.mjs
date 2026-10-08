import { shardCapabilities } from "../lib/capability-shards.mjs";

// An entirely synthetic source: these are not installed Skills and may not
// be suggested as evidence of real machine capability.
const SPEC = [
  [
    "a-base-url",
    "Feishu Base URL resolver. For a read-only Lark Base workflow, parse the supplied Base URL and resolve its app token plus table ID. Return identifiers only; no record fetching, authentication checks, network calls, or business mutations. Its output is required by a separate record-list operation.",
  ],
  [
    "b-cloud-deploy",
    "Cloud application deployment helper. Assists with release uploads, environment variables, and cloud runtime deployment planning. It cannot parse Feishu Base URLs and cannot retrieve Base records. Requires cloud network access and deployment credentials, which are unrelated to this request.",
  ],
  [
    "c-base-records",
    "Feishu Base record-list helper. Lists table records given both an app token and table ID, using an authenticated Lark CLI. It cannot resolve arbitrary Base URLs itself. Combining a Base URL resolver with this tool yields an end-to-end read-only data retrieval plan. Do not call the service in advisor mode.",
  ],
  [
    "d-markdown-preview",
    "Local Markdown presentation guidance. Uses an editor's built-in Markdown rendering preview to inspect .md files. It does not access Feishu, cannot resolve Base tokens or table IDs, and cannot retrieve remote records. No server is needed for Markdown viewing.",
  ],
];

export function buildSyntheticTwoShardPlan() {
  const items = SPEC.map(([name, description]) => ({
    id: "skill:fixture:" + name,
    name,
    description,
    group: "skill:" + name,
    source: "isolated-test-fixture",
    location: "fixture://" + name + "/SKILL.md",
    fingerprint: "synthetic-" + name,
  }));
  const targetBytes = 1100; // Small ONLY for testing parallel Main synthesis.
  const plan = shardCapabilities(items, { targetBytes, parallelism: 2 });
  if (plan.shardCount !== 2 ||
      plan.shards.some(shard => shard.count !== 2) ||
      !plan.coverageComplete) {
    throw new Error("Two-shard fixture contract drifted: " +
      JSON.stringify(plan.shards.map(s => ({ id: s.id, count: s.count, bytes: s.bytes }))));
  }
  return plan;
}
