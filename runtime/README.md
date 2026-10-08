# how-to-use runtime

This directory contains the local runtime used by the RDC Coding Runtime plugin's `how-to-use` capability advisor.

Stable compatibility (currently installed): ChatGPT Plugin `0.6.5` uses local capability runtime `0.6.2` from `main@8965d1761cbd50ce346b60a3646fc3b3c2549c52`. These are independent component versions. **This development branch contains a not-yet-installed local runtime candidate `0.7.0-dev.3`** with Skill Hub planning and opt-in parallel Pi advising. It does not modify the stable pin, user's installed runtime, or Plugin release.

## Files

- `how-to-use.mjs` — launcher/runtime adapter for one restricted native Pi Agent advisor run.
- `pi-capability-tools.ts` — narrow read-only Pi extension exposing deterministic capability evidence tools.
- `rdc-cap.mjs` — deterministic capability discovery CLI (`context/find/describe`).
- `lib/capabilities.mjs` — shared bounded discovery and projection module used by both the CLI and Pi extension.
- `bootstrap-router.mjs` — creates or migrates the dedicated router configuration and opens it for user editing.
- `capabilities.test.mjs` — source-level regression coverage; it is not required in the installed runtime.
- `skill-hub.mjs` — `plan` (read-only), `shard` (read-only), and `sync` (owned links only).
- `lib/skill-hub.mjs` — deterministic source inventory, bundle-level version choice and managed Junction/symlink reconciliation.
- `lib/skill-hub-roots.mjs` — verifies managed link targets before allowing `rdc-cap` discovery.
- `lib/capability-shards.mjs` — deterministic, full-coverage 256 KiB candidate metadata partitioning.
- `skill-hub.test.mjs` — isolated link, bundle, ownership, and 5,000-item shard regression coverage.
- `pi-capability-fanout.ts` — opt-in Pi Main tool that plans shards and dispatches ephemeral Workers.
- `lib/pi-advisor-fanout.mjs` — bounded concurrent Pi process scheduler, worker result validation and coverage reporting.
- `pi-advisor-fanout.test.mjs` — worker process, structured output, concurrency and failure-path regressions.

## Local layout

The runtime is installed under:

```text
~/.rdc/how-to-use/
├── how-to-use.mjs
├── pi-capability-tools.ts
├── rdc-cap.mjs
├── lib/
│   └── capabilities.mjs
├── bootstrap-router.mjs
├── config.json
├── backend-state.json
└── pi-agent/
    ├── models.json
    ├── settings.json
    └── APPEND_SYSTEM.md
```

`config.json` is the single user-edited configuration source:

```json
{
  "api": "anthropic-messages",
  "baseUrl": "REPLACE_WITH_API_BASE_URL",
  "apiKey": "REPLACE_WITH_YOUR_API_KEY",
  "model": "REPLACE_WITH_MODEL_ID",
  "thinking": "medium"
}
```

Supported API modes in the current runtime are `anthropic-messages` and `openai-completions`.

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, subject to the selected model/provider actually supporting the requested level.

## Pi isolation and Skill sharing

The router uses a dedicated Pi agent directory under `~/.rdc/how-to-use/pi-agent` so it does not change the user's normal Pi provider/model defaults.

The dedicated runtime references user Pi Skills from `~/.pi/agent/skills`. Pi's native shared `~/.agents/skills` source remains available as well.

The local advisor is read-only: Pi is limited to `read`, `grep`, `find`, and `ls`. The primary ChatGPT Web agent remains responsible for all effectful actions through RDC.

## Commands

```text
how-to-use --bootstrap
how-to-use --reconfigure
how-to-use --verify-config
how-to-use --benchmark
how-to-use --self-check
how-to-use [--workspace <path>] "<bounded task capsule>"
how-to-use --offline [--workspace <path>] "<task>"

rdc-cap context --workspace <path> [--query <task-for-provenance>] [--json]
rdc-cap find <exact-name-or-id> --workspace <path> [--json]
rdc-cap describe <capability-id> --workspace <path> [--json]
```

During source development the discovery CLI can also be run as `node runtime/rdc-cap.mjs ...`. The stable plugin bootstrap must expose the `rdc-cap` command shim when this runtime version is released.

## Discovery vs semantic routing

`rdc-cap` is intentionally read-only and deterministic. It discovers facts; it does **not** decide which capability is semantically relevant to a natural-language task.

The default discovery domain is bounded to:

- `~/.agents/skills` and `~/.pi/agent/skills`;
- workspace Skill roots only when root project instructions explicitly reference those roots;
- `package.json` / `pyproject.toml` declarations in the selected workspace;
- exact PATH resolution only for an explicitly named command;
- sanitized durable hints from `~/.rdc/MACHINE_CONTEXT.md`.

`rdc-cap context` returns an **unranked** capability catalog. The optional `--query` is retained as task/provenance context; it is not tokenized, scored, or used to filter capabilities. `rdc-cap find` is an exact capability-name/ID lookup, not a semantic search endpoint.

Semantic work belongs to one native Pi Agent run:

1. `how-to-use` launches Pi once in the requested workspace with Skills enabled.
2. Pi sees installed Skill names/descriptions, loads full Skill instructions on demand, and owns the model -> tool -> result -> next-turn Agent Loop.
3. Pi can use only `read/grep/find/ls` plus the narrow read-only evidence tools `capability_context`, `capability_describe`, and `command_resolve`.
4. Those evidence tools reuse `lib/capabilities.mjs`; they do not perform semantic ranking, execute arbitrary commands, or mutate the machine.
5. Pi returns final advice to the primary ChatGPT Web agent, which still owns all effectful RDC operations.

There is no stop-word list, lexical score, keyword threshold, regex natural-language CLI extraction, manual Skill preselection, route-JSON pass, or second advice-model pass in the production semantic path.

`how-to-use --offline` explicitly disables Router inference and returns only the unranked deterministic catalog. Use it when advisor/control-plane network access itself is prohibited. Natural-language task constraints are otherwise interpreted by the LLM and applied to the target operation; they are not parsed by hand-written keyword rules.

The runtime does not enumerate every PATH executable or recursively inventory the home directory. Symlink/Junction targets may be followed only when they stay inside explicitly allowed Skill roots. Starting with the `0.7.0-dev.1` candidate, an additional **exact allowlist** is derived from Skill Hub-owned links whose live target matches the ownership ledger. Other external links remain excluded. `rdc-cap` does not scan arbitrary Codex plugin caches.

Normal advisor requests do not rewrite generated `models.json` / `settings.json`; those files are synchronized by bootstrap/config verification.

## Skill Hub candidate (introduced in 0.7.0-dev.1)

The preferred user-owned global location for **new local installs** is `~/.agents/skills/`. Existing client-managed installations remain in place. The Hub creates Windows Junctions (directory symlinks elsewhere), not copies, for missing global names. It does not install/uninstall packages or modify any source Skill.

Developer entrypoints (not yet installed as a user-level shim):

```powershell
node runtime/skill-hub.mjs plan
node runtime/skill-hub.mjs plan --json
node runtime/skill-hub.mjs shard --target-bytes 262144 --parallelism 4 --json
node runtime/skill-hub.mjs sync
```

`plan` and `shard` are **read-only**. `sync` must be explicitly invoked; neither `rdc-cap` nor `how-to-use` invokes it automatically. Before syncing a real machine, inspect the proposed action list. For isolated tests, supply `--home <fixture>` and repeated `--source alias=path` options; explicit sources replace the default external source list. Optional `--groups file.json` supports `{"bundles":{"bundle-name":["skill-a","skill-b"]}}` for a group without install manifests.

Default global sources: `~/.agents/skills` (hub), `~/.pi/agent/skills`, `~/.claude/skills`, `~/.codex/skills` (excluding client `.system` Skills), `~/.kiro/skills`, and the `skills/` directory of each currently **enabled and installed** Claude Code plugin. Project-scoped Skills are deliberately not promoted globally. Unreadable/invalid source metadata blocks sync rather than silently shrinking the catalog.

Version choice is deterministic: identical **Skill directory content** is treated as equal regardless of copied file modification times, preferring an existing hub copy. Different content uses the newest file modification time across the entire Skill directory, with deterministic source tie-breaking. Client-targeted `.*-install.json` files are excluded from content fingerprints; their `installedVersion` / `buildCommit` identify release families. Skills sharing the same install-manifest family (e.g. the 13 TWG Skills) are selected **from one source installation as a complete group**, never per-file across clients. Invalid mixed release manifests block sync. For unmanaged hub directories with genuinely different content, `plan` reports a conflict rather than deleting user data.

The syncer only replaces or removes its **own** unchanged links and persists ownership in `~/.rdc/skill-hub/links.json`. A changed real directory or redirected link is never overwritten. A lock file prevents concurrent syncs. Ledger updates occur after each successful action so a partial filesystem failure remains reconcilable. An external link becomes readable by `rdc-cap` only if the ledger, live link, and original target agree. Arbitrary external links are not allowed.

`shard` uses the fully selected descriptions, stable hub IDs, source locations, and content fingerprints; it does not score, embed, semantically prefilter, or truncate candidates. The default is **262,144 UTF-8 bytes per shard** with `--parallelism 4`. An indivisible oversized item is retained intact and flagged. The `shard` command itself does not spawn any Pi process; only the opt-in P2 advisor invokes Workers. The development launcher has a 300,000 ms root advisory timeout; the installed 0.6.2 launcher retains its old limit until a separately reviewed release.

Test with: `node --test runtime/capabilities.test.mjs runtime/skill-hub.test.mjs runtime/pi-advisor-fanout.test.mjs`. Do not run `sync` against the user's real hub as a side effect of testing or bootstrapping.

## Experimental Parallel Pi Advisor (P2; 0.7.0-dev.2)

Run the source candidate explicitly; it is **not** the installed CLI behavior:

```powershell
node runtime/how-to-use.mjs --parallel-advisor --workspace <repo> "Explain the current local capability needed for this read-only task."
```

The experimental option preserves the existing `how-to-use` single-Pi default when omitted. A short-lived Pi Main gets one additional tool, `capability_fanout`, then invokes the deterministic Skill Hub planner locally. It sends each complete shard as stdin to a separate ephemeral Pi Worker process. Main does not preload the full Skill catalog; each Worker gets all original descriptions from its assigned shard, without lexical filtering or retrieval scoring.

Implementation specifics:

- Worker command: actual local Pi CLI under PowerShell on Windows, `--mode json -p --no-session --no-skills --no-extensions --no-context-files --no-approve --no-tools`. Each Worker retains the dedicated Pi provider/model configuration; no new model credential files are created.
- Input: full metadata shard via stdin, because 256 KiB does not fit reliably in Windows command-line arguments.
- Model output: exact capability IDs only; at most five meaningful candidates per shard. IDs are validated against the assigned shard, with original descriptions included for Main's cross-shard reasoning.
- Concurrency: default 4, experimental settings 1/2/4/8; one root RDC PID remains authoritative. Per-Worker timeout: 120 seconds; root `how-to-use` budget: 300 seconds including final synthesis.
- Failure semantics: invalid Worker JSON, unknown IDs, timeout, cancellation and missing shards remain explicit `incomplete/failed` results. A failed Worker does not count as a negative Skill evaluation, and no blind subprocess retries are attempted.
- Data: Skill Hub planning is performed in-memory and read-only. This mode never invokes the Hub's `sync` command. Pi Workers cannot execute source Skills or local business CLIs.
- Test coverage: see `runtime/pi-advisor-fanout.test.mjs` for Windows process stdin, parallel scheduling, output validation, error/coverage handling and 5,000-item deterministic shard fixtures.

This is a **development-only experiment**. Before considering a Runtime/Plugin release, it still needs repeated end-to-end fresh-session selection-quality evaluation, cancellation/Windows descendant-process verification, and cost/latency benchmarks against single-Pi behavior. It does not add MCP discovery or Jev/embedding/keyword routing. The P3 iteration below refines quality reasoning without replacing the full-coverage Skill fanout.

### P2 development dogfood (2026-10-08)

- Windows Pi 0.87.1, Node 24.11.0; all 54 source tests passed (existing source + Skill Hub + P2); JavaScript syntax tests and diff checks passed.
- Full source launcher with `--parallel-advisor`: RDC PID 39772, exit 0 after 31.17 seconds. Pi Main used one real Worker to cover 97 local Skill descriptions in one shard, no missing shard, and returned a grounded VS Code Markdown Preview recommendation. It did not sync/install local Skills.
- Separate real-model concurrent-Worker fixture: RDC PID 13984, exit 0. Two actual Pi Workers on two isolated test-only shards both returned complete, with 2.88 seconds total wall time (individual durations 2.40s and 2.87s). The Markdown-relevant shard selected its local fixture ID; the unrelated cloud-deployment shard returned no candidate. This fixture deliberately lowered shard size solely to force two Workers; the standard planner remains 256 KiB per shard.
- Structured usage was captured but the provider reported 0 priced cost; this is not proof that API calls were free. Long-run token/cost/latency and selection-quality benchmarks remain outstanding.
- Stable user installation and Plugin were not modified. Real `~/.agents/skills` was not synced. The new feature remains opt-in on the unmerged development branch.

## P3: result quality is not Skill ranking (0.7.0-dev.3)

The Skill fanout is a **recall mechanism**: every assigned Worker reads every full
Skill description in its shard, with no lexical/embedding prefilter. However,
a returned Skill is only a *candidate*, not proof that it best satisfies the
task or that its runtime prerequisites are present.

The Pi Main decision contract now:

- Derives the user's actual success condition and restrictions before choosing.
- Independently considers existing direct local options: editor/native UI features,
  OS facilities, project scripts, and exact CLIs, even when no Skill was selected.
- Uses targeted `read/ls/grep/find` and exact `command_resolve` for evidence;
  a resolved CLI alone does not establish a plugin, renderer, service, or authentication.
- Compares Skill and native options against the **same** success criteria.
  A no-Skill solution may win; a conditional Skill must state its missing prerequisites.
- Does not downgrade rendered output to merely opening/transporting a raw file.
- Retains explicit Skill shard coverage and does not misrepresent it as full
  inventory of every locally installed program.

This is prompt-level semantic decision policy implemented in
`lib/pi-advisor-decision.mjs`. It introduces no string matching or second
Agent Router. Worker instructions additionally require explicit task-fit and
unverified dependency notes. Pi 1.1.0's `--no-mcp` is set for the opt-in
Main and ephemeral Workers, without changing the already installed Runtime.

Quality regression originating this change: for a local Markdown book requiring
graphical rendered preview with no installation or server, a prior run recommended
`browser-skill` despite lacking evidence that the browser could render Markdown.
A direct built-in editor preview is a better candidate when its CLI is verified.
Tests cover the decision contract and source compatibility; real Pi quality
must be assessed separately. P3's first live run uses RDC owner PID `21588`
and was still pending at the time this section was drafted; do not mark PASS
based solely on the process being started.

Validation: `node --test runtime/capabilities.test.mjs runtime/skill-hub.test.mjs runtime/pi-advisor-fanout.test.mjs`
has **57 PASS / 0 FAIL** for this source iteration. The stable local runtime
remains `0.6.2`; the ChatGPT Plugin remains `0.6.5`. No Skill Hub `sync` was run.

---

## Dogfood evidence

Validated on Windows with Pi 0.87.1 and a dedicated Anthropic Messages-compatible Claude Sonnet 4.6 endpoint.

RDC Local Capability Runtime v1 dogfood:

- Runtime 0.6.1 restored the production advisor to **one native Pi Agent run** while preserving deterministic discovery.
- Fresh-session 0.6.1 dogfood proved the native Pi run itself worked, but the primary agent started duplicate `Get-Command` / editor inspection while the owning advisor PID was still alive.
- Runtime 0.6.2 candidate hardens that remaining control-plane seam: it emits `advisor_running ... wait_for_pid=true` immediately before the blocking Pi run and documents active PID ownership as an exclusive capability-investigation gate.
- A source smoke confirmed the marker appears in initial process output while the same advisor PID remains active.
- `node --test runtime/capabilities.test.mjs`: **24 passed, 0 failed**; syntax checks and `git diff --check` also pass.
- `rdc-cap context` remains an **unranked** evidence catalog with `semanticSelectionPerformed=false`; `rdc-cap find` remains exact name/ID lookup only.
- Production `how-to-use` no longer contains `routePrompt / parseJsonObject / normalizeRoute / collectEvidence / finalPrompt / semanticAdvisor / modelCall` and no longer disables tools or Skills.
- The Pi run is restricted to `read/grep/find/ls` plus `capability_context / capability_describe / command_resolve`; the extension reuses `lib/capabilities.mjs` and has no generic shell or mutation tool.
- Live Markdown-book source dogfood completed as `backend=pi ... agent_loop=native` in about 39 seconds. Pi verified `code` on PATH, rejected raw HTTP serving as a Markdown-preview substitute, and selected VS Code's built-in rendered preview without install/download/mutation.
- Live Feishu/Lark Base source dogfood completed as `backend=pi ... agent_loop=native` in about 27 seconds. With no preselected Skill, Pi loaded `skill:agents:lark-base:9c3a2cf22a` from `~/.agents/skills`, verified `lark-cli`, and recovered the real `+url-resolve -> +record-list` path without calling the external business system.
- Package-manager inference still returns unknown when neither `packageManager` nor a supported lockfile provides evidence; npm is not an unconditional fallback.
Observed benchmark:

```text
basic_inference=PASS 2255ms
skill_routing=PASS 2362ms
schema_reasoning=PASS 2761ms
```

After migration to the single `config.json` source, re-validation also passed:

```text
pi_usable=true
preferred_backend=pi
basic_inference=PASS 1898ms
skill_routing=PASS 2342ms
schema_reasoning=PASS 2681ms
```

A real read-only Feishu/Lark Base task selected the installed `lark-base` Skill and returned the evidence-backed `+url-resolve -> +record-list` path.


## Advisor guardrails

The primary ChatGPT agent should launch one `how-to-use` request and treat that PID as the **exclusive owner of capability investigation** until it exits, errors, or reaches the advisor timeout. A normal advisor request can be silent for tens of seconds. An empty `read_process_output` does **not** release PID ownership and is not permission to branch into a parallel investigation.

While that PID is active, do not start `Get-Command`/PATH scans, npm-global scans, editor-install inspection, another `rdc-cap`, another advisor, Skill-root scans, home-directory scans, or package-tree inventory for the same capability question. Continue observing the same PID only. After it exits, perform only targeted live verification of claims that materially affect the decision.

The launcher emits an immediate progress marker before entering the blocking native Pi run:

```text
[how-to-use] advisor_running backend=pi agent_loop=native wait_for_pid=true timeout_ms=300000
```

Treat `wait_for_pid=true` as an explicit control-plane gate: do not duplicate capability investigation while the owning PID is alive.

The Pi model interprets task constraints such as read-only, no-install, no-download, no-network, and no-mutation semantically inside the same Agent run. Deterministic evidence tools do not parse natural language through regexes, stop-word lists, or lexical scoring.

Stable user-level capabilities are preferred over private dependencies embedded inside another application's package tree. Pi must use the narrow evidence tools for claims that require deterministic proof: exact capability IDs are re-resolved with `capability_describe`, and exact CLI installation claims are checked with `command_resolve`.

A normal successful request emits bounded runtime metadata, for example:

```text
[how-to-use] backend=pi model=claude-sonnet-4-6 thinking=xhigh agent_loop=native elapsed_ms=...
```

Production advice is one Pi Agent run. Skill selection happens through Pi's native Skill discovery/loading, while exact capability and CLI evidence is obtained only when Pi calls the narrow read-only evidence tools.
