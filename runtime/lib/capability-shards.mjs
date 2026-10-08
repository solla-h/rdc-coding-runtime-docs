import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseSkillFrontmatter } from "./capabilities.mjs";

export const DEFAULT_SHARD_BYTES = 256 * 1024;
export const DEFAULT_PARALLELISM = 4;

export function shardCapabilities(items, {
  targetBytes = DEFAULT_SHARD_BYTES,
  parallelism = DEFAULT_PARALLELISM,
} = {}) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1024) {
    throw new Error("targetBytes must be an integer of at least 1024");
  }
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 32) {
    throw new Error("parallelism must be an integer from 1 to 32");
  }
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id, "en"));
  const seen = new Set();
  const shards = [];
  let current = [];
  let used = 2;
  function emit() {
    if (!current.length) return;
    const bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    shards.push({
      id: "shard-" + String(shards.length + 1).padStart(4, "0"),
      count: current.length, bytes, oversized: bytes > targetBytes, items: current,
    });
    current = [];
    used = 2;
  }
  for (const item of sorted) {
    if (!item || typeof item.id !== "string" || typeof item.description !== "string") {
      throw new Error("Each item needs a stable id and complete description");
    }
    if (seen.has(item.id)) throw new Error("Duplicate capability id: " + item.id);
    seen.add(item.id);
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const increment = bytes + Number(current.length > 0);
    if (current.length && used + increment > targetBytes) emit();
    current.push(item);
    used += bytes + Number(current.length > 1);
  }
  emit();
  const allIds = shards.flatMap(group => group.items.map(item => item.id));
  const digest = crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return {
    schema: 1, targetBytes, parallelism,
    itemCount: sorted.length,
    shardCount: shards.length,
    waves: Math.ceil(shards.length / parallelism),
    coverageComplete: allIds.length === sorted.length && new Set(allIds).size === sorted.length,
    oversizedShards: shards.filter(s => s.oversized).map(s => s.id),
    inputDigest: digest,
    shards,
  };
}

export function shardHubSelection(hubPlan, options = {}) {
  if (!hubPlan.canSync) throw new Error("Cannot shard an incomplete or blocked Skill Hub plan");
  const items = hubPlan.selected.map(entry => {
    const content = fs.readFileSync(path.join(entry.target, "SKILL.md"), "utf8");
    const metadata = parseSkillFrontmatter(content);
    if (!metadata.name || metadata.name.toLowerCase() !== entry.name.toLowerCase()) {
      throw new Error("Skill metadata changed during planning: " + entry.target);
    }
    return {
      id: "skill:hub:" + entry.name.toLowerCase(),
      name: entry.name,
      description: metadata.description,
      group: entry.group,
      source: entry.source,
      location: path.join(entry.target, "SKILL.md"),
      fingerprint: entry.fingerprint,
    };
  });
  return shardCapabilities(items, options);
}
