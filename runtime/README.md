# how-to-use runtime

This directory contains the local runtime used by the RDC Coding Runtime plugin's `how-to-use` capability advisor.

## Files

- `how-to-use.mjs` — local capability router/advisor CLI.
- `rdc-cap.mjs` — deterministic capability discovery CLI (`context/find/describe`).
- `lib/capabilities.mjs` — shared bounded discovery and projection module used by both CLIs.
- `bootstrap-router.mjs` — creates or migrates the dedicated router configuration and opens it for user editing.
- `capabilities.test.mjs` — source-level regression coverage; it is not required in the installed runtime.

## Local layout

The runtime is installed under:

```text
~/.rdc/how-to-use/
├── how-to-use.mjs
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

Semantic work belongs to an LLM:

1. `how-to-use` sends the bounded unranked catalog, machine hints, project evidence, and task to the configured Router model.
2. The Router returns structured JSON with selected stable capability IDs, exact CLI names that require verification, normalized task constraints, and a reason.
3. Runtime code validates IDs and performs exact PATH checks; it never treats an LLM candidate as proof of installation.
4. A second LLM pass produces advice grounded in the verified descriptors and command-resolution evidence.

There is no stop-word list, lexical score, keyword threshold, regex natural-language CLI extraction, or Skill preselection in the semantic path.

`how-to-use --offline` explicitly disables Router inference and returns only the unranked deterministic catalog. Use it when advisor/control-plane network access itself is prohibited. Natural-language task constraints are otherwise interpreted by the LLM and applied to the target operation; they are not parsed by hand-written keyword rules.

The runtime does not scan the Codex plugin cache, enumerate every PATH executable, or recursively inventory the home directory. Symlink/Junction targets may be followed only when they stay inside the set of explicitly allowed Skill roots; canonical paths prevent the same Skill from being registered twice.

Normal advisor requests do not rewrite generated `models.json` / `settings.json`; those files are synchronized by bootstrap/config verification.

## Dogfood evidence

Validated on Windows with Pi 0.87.1 and a dedicated Anthropic Messages-compatible Claude Sonnet 4.6 endpoint.

RDC Local Capability Runtime v1 dogfood:

- Runtime 0.6.0 removes deterministic semantic ranking from the discovery layer.
- `node --test runtime/capabilities.test.mjs`: **22 passed, 0 failed** during the 0.6.0 refactor.
- `rdc-cap context` returns an unranked catalog with `semanticSelectionPerformed=false`; natural-language prose does not change which Skill summaries appear.
- `rdc-cap find` performs exact name/ID lookup and exact command resolution only; natural-language prose does not trigger PATH probes.
- Package-manager inference now returns unknown when neither `packageManager` nor a supported lockfile provides evidence; npm is no longer an unconditional fallback.
- Live 0.6.0 Router dogfood on `claude-code-book` selected **no unrelated Skill**, semantically proposed `mdbook/mkdocs/docsify/vitepress/honkit/gitbook/node/npm` as CLI candidates, verified the first six absent and Node/npm present, and recommended project inspection rather than the previous false `review` / `lark-markdown` matches.
- Positive routing dogfood for a Feishu/Lark Base read task selected stable capability ID `skill:agents:lark-base:9c3a2cf22a`, proposed `lark-cli` for exact PATH verification, verified it, and generated advice from the real Skill instructions.
- Both live semantic dogfoods completed with `backend=pi model=claude-sonnet-4-6 thinking=xhigh` in about 20 seconds each and performed no project mutation or installation.

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

The primary ChatGPT agent should launch one `how-to-use` request and keep ownership of that PID. A normal advisor request can be silent for tens of seconds; do not kill or duplicate it merely because output has not appeared yet. The current advisor path allows roughly 90 seconds for Pi reasoning before treating it as a timeout.

While an advisor request is running, do not start a second broad inventory of PATH tools, npm globals, Skill roots, home directories, or package trees. Wait for the advisor result, then perform only targeted live verification of claims that matter to the decision.

The Router model interprets task constraints such as read-only, no-install, no-download, no-network, and no-mutation semantically and returns them in a structured decision. Runtime code then uses those constraints as evidence for advice; it does not attempt to understand natural language through regexes or stop-word lists.

Stable user-level capabilities are preferred over private dependencies embedded inside another application's package tree. The Router distinguishes verified capabilities from candidates requiring verification, while runtime code owns the actual verification.

A normal successful request emits bounded runtime metadata, for example:

```text
[how-to-use] backend=pi model=claude-sonnet-4-6 thinking=xhigh selected_capabilities=none command_candidates=mdbook,mkdocs,docsify,vitepress,node,npm elapsed_ms=19804
```

There is no deterministic Skill preselection in 0.6.0. Stable capability IDs selected by the LLM are re-resolved before their instructions are used.
