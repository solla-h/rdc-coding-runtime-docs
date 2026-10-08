# how-to-use runtime

This directory contains the local runtime used by the RDC Coding Runtime plugin's `how-to-use` capability advisor.

Current compatibility: ChatGPT Plugin `0.6.5` continues to use local capability runtime `0.6.2` from `main@8965d1761cbd50ce346b60a3646fc3b3c2549c52`. These are independent component versions: Plugin `0.6.5` clarifies process-exit versus effect-state reconciliation and safe retry policy; it does not add or change a local Runtime state machine.

## Files

- `how-to-use.mjs` — launcher/runtime adapter for one restricted native Pi Agent advisor run.
- `pi-capability-tools.ts` — narrow read-only Pi extension exposing deterministic capability evidence tools.
- `rdc-cap.mjs` — deterministic capability discovery CLI (`context/find/describe`).
- `lib/capabilities.mjs` — shared bounded discovery and projection module used by both the CLI and Pi extension.
- `bootstrap-router.mjs` — creates or migrates the dedicated router configuration and opens it for user editing.
- `capabilities.test.mjs` — source-level regression coverage; it is not required in the installed runtime.

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

The runtime does not scan the Codex plugin cache, enumerate every PATH executable, or recursively inventory the home directory. Symlink/Junction targets may be followed only when they stay inside the set of explicitly allowed Skill roots; canonical paths prevent the same Skill from being registered twice.

Normal advisor requests do not rewrite generated `models.json` / `settings.json`; those files are synchronized by bootstrap/config verification.

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
[how-to-use] advisor_running backend=pi agent_loop=native wait_for_pid=true timeout_ms=90000
```

Treat `wait_for_pid=true` as an explicit control-plane gate: do not duplicate capability investigation while the owning PID is alive.

The Pi model interprets task constraints such as read-only, no-install, no-download, no-network, and no-mutation semantically inside the same Agent run. Deterministic evidence tools do not parse natural language through regexes, stop-word lists, or lexical scoring.

Stable user-level capabilities are preferred over private dependencies embedded inside another application's package tree. Pi must use the narrow evidence tools for claims that require deterministic proof: exact capability IDs are re-resolved with `capability_describe`, and exact CLI installation claims are checked with `command_resolve`.

A normal successful request emits bounded runtime metadata, for example:

```text
[how-to-use] backend=pi model=claude-sonnet-4-6 thinking=xhigh agent_loop=native elapsed_ms=...
```

Production advice is one Pi Agent run. Skill selection happens through Pi's native Skill discovery/loading, while exact capability and CLI evidence is obtained only when Pi calls the narrow read-only evidence tools.
