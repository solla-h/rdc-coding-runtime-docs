import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Build a narrowly verified allowlist for the existing bounded Skill scanner.
// This adds only the exact targets of Skill Hub-owned and unchanged directory
// links as roots. It does not relax traversal for arbitrary symlinks.
export function managedSkillLinkRoots({ home = os.homedir() } = {}) {
  const hub = path.join(home, ".agents", "skills");
  const state = path.join(home, ".rdc", "skill-hub", "links.json");
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(state, "utf8")); }
  catch { return []; }
  if (ledger?.schema !== 1 || typeof ledger.hub !== "string" ||
      path.resolve(ledger.hub).toLowerCase() !== path.resolve(hub).toLowerCase() ||
      !ledger.links || typeof ledger.links !== "object") return [];
  const roots = [];
  for (const [name, item] of Object.entries(ledger.links)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || typeof item?.target !== "string") continue;
    const link = path.join(hub, name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      const actual = fs.realpathSync(link);
      const expected = fs.realpathSync(item.target);
      if (path.resolve(actual).toLowerCase() !== path.resolve(expected).toLowerCase()) continue;
      if (!fs.statSync(path.join(actual, "SKILL.md")).isFile()) continue;
      roots.push({ alias: "hub-managed-" + String(roots.length + 1), path: actual });
    } catch { /* drifted or missing links do not become trusted Skill roots */ }
  }
  return roots;
}
