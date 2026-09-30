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
how-to-use "<bounded task capsule>"

rdc-cap context --workspace <path> [--query <short-task>] [--json]
rdc-cap find <query> --workspace <path> [--json]
rdc-cap describe <capability-id> --workspace <path> [--json]
```

During source development the discovery CLI can also be run as `node runtime/rdc-cap.mjs ...`. The stable plugin bootstrap must expose the `rdc-cap` command shim when this runtime version is released.

## Deterministic capability discovery

`rdc-cap` is intentionally read-only. Its discovery path does not install, download, call the Router model, read Router credentials, start discovered tools, or write runtime/project files.

The default discovery domain is bounded to:

- `~/.agents/skills` and `~/.pi/agent/skills`;
- workspace Skill roots only when root project instructions explicitly reference those roots;
- `package.json` / `pyproject.toml` declarations in the selected workspace;
- exact PATH resolution for task-relevant or explicitly queried commands;
- sanitized durable hints from `~/.rdc/MACHINE_CONTEXT.md`.

It does not scan the Codex plugin cache, enumerate every PATH executable, or recursively inventory the home directory. Symlink/Junction targets may be followed only when they stay inside the set of explicitly allowed Skill roots; canonical paths prevent the same Skill from being registered twice.

`how-to-use` reuses the same Skill discovery module. Normal advisor requests no longer rewrite generated `models.json` / `settings.json`; those files are synchronized by bootstrap/config verification. Tasks that explicitly require read-only/no-mutation or no-network behavior fall back to deterministic local discovery instead of starting the remote advisor.

## Dogfood evidence

Validated on Windows with Pi 0.87.1 and a dedicated Anthropic Messages-compatible Claude Sonnet 4.6 endpoint.

RDC Local Capability Runtime v1 dogfood on 2026-09-29:

- `node --test runtime/capabilities.test.mjs`: **20 passed, 0 failed**.
- Live `context --query git` against the real machine Skill roots: 0 incomplete sources after canonical cross-root Junction handling; serialized result remained below the 12 KiB budget.
- Live `find git -> describe <command-id>` re-resolved the current PATH command and returned `command_resolves`.
- Runtime 0.5.1 hardening: `read-only no-network determine whether docsify is installed` probes only `command:docsify`; with Docsify absent it returns 0 matches / 0 capabilities / `hasMore=false` and deterministic metadata reports `preselected_skill=none`.
- A normal Pi-backed `how-to-use` request completed successfully while SHA256 and modification times for generated `models.json` and `settings.json` remained unchanged.

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

The router treats task constraints such as read-only, no-install, no-download, no-network, and no-mutation as hard requirements. Options that require a prohibited action must be labeled as future options instead of currently usable paths.

Stable user-level capabilities are preferred over private dependencies embedded inside another application's package tree. The router also distinguishes verified capabilities from inferred or future ones and avoids inferring one installed tool merely from the presence of another.

A normal successful request emits bounded runtime metadata, for example:

```text
[how-to-use] backend=pi model=claude-sonnet-4-6 thinking=xhigh preselected_skill=none elapsed_ms=14530
```

Skill preselection is intentionally conservative: multi-token Skill names require a phrase match or at least two distinctive non-generic name tokens. Generic terms such as `git`, `code`, `claude`, `agent`, `skill`, and `tool` do not by themselves justify preselection.
