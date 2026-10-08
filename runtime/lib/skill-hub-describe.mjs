import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITY_SCHEMA_VERSION,
  CAPABILITY_RUNTIME_VERSION,
  parseSkillFrontmatter,
} from "./capabilities.mjs";
import { planSkillHub } from "./skill-hub.mjs";

const HUB_ID = /^skill:hub:([a-z0-9][a-z0-9._-]*)$/i;

// Resolve the *exact* virtual Skill ID issued by shardHubSelection.
// Never reinterpret arbitrary paths as IDs or search other Skills by similarity.
export function describeHubSelectedSkill(id, {
  maxSkillContentChars = 18000,
  ...hubOptions
} = {}) {
  const observedAt = new Date().toISOString();
  const base = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    runtimeVersion: CAPABILITY_RUNTIME_VERSION,
    observedAt,
    capabilityId: id,
  };
  const match = typeof id === "string" ? id.match(HUB_ID) : null;
  if (!match) return { ...base, found: false, reason: "invalid_hub_id" };
  if (!Number.isInteger(maxSkillContentChars) || maxSkillContentChars < 1 ||
      maxSkillContentChars > 60000) throw new Error("Invalid Skill instruction limit");

  const catalog = planSkillHub(hubOptions);
  const coverage = {
    sourcesChecked: catalog.sourcesChecked,
    incompleteSources: catalog.incompleteSources,
    hasMore: !catalog.canSync,
  };
  if (!catalog.canSync) {
    return { ...base, found: false, reason: "hub_plan_incomplete_or_blocked",
      blocked: catalog.blocked, coverage };
  }
  const selected = catalog.selected.filter(entry =>
    entry.name.toLowerCase() === match[1].toLowerCase());
  if (selected.length !== 1) return { ...base, found: false,
    reason: "hub_id_not_selected", coverage };
  const item = selected[0];
  const skillPath = path.join(item.target, "SKILL.md");
  let full;
  try { full = fs.readFileSync(skillPath, "utf8"); }
  catch { return { ...base, found: false, reason: "selected_skill_unreadable", coverage }; }
  const metadata = parseSkillFrontmatter(full);
  if (!metadata.name || metadata.name.toLowerCase() !== item.name.toLowerCase()) {
    return { ...base, found: false, reason: "selected_skill_changed", coverage };
  }
  const contentComplete = full.length <= maxSkillContentChars;
  return {
    ...base, found: true, coverage,
    capability: {
      id, kind: "skill", name: item.name,
      summary: metadata.description || "",
      source: { adapter: "skill-hub-selected", location: skillPath },
      details: {
        skillPath, source: item.source, group: item.group,
        fingerprint: item.fingerprint,
        content: full.slice(0, maxSkillContentChars),
        contentComplete,
        ...(!contentComplete ? { readFullPath: skillPath } : {}),
      },
    },
  };
}
