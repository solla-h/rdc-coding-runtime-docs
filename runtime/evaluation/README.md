# P3 Pi Advisor evaluation

This directory contains **developer dogfood**, not a second Router or a Job runtime. Production still uses the original 256 KiB deterministic Skill sharding. These tests never create Hub links, install Skills, query real Feishu records, or call arbitrary local mutation tools.

## Test matrix

| ID | Task | Expected human-observable result | Status |
| --- | --- | --- | --- |
| P3-A | Local Markdown graphical preview without install, download, server, or mutation | Native VS Code Markdown Preview should win over conditional browser Skills; `code` path must be verified | PASS at inherited PID 21588, Pi 1.1.0, 1/1 shard, ~29 s |
| P3-B | Read Feishu Base records; **advice only**, no real API access | Dedicated `lark-base` Skill and `lark-cli` should be recommended if installed; URL resolution before record listing; authentication remains unverified | PASS at PID 25736, exit 0, 1/1 shard, ~39.6 s; identified virtual Hub ID lookup regression, addressed by unit-tested fix |
| P3-C | Genuine no-match / insufficient evidence | Distinguish no matching Skill from lack of usable native capability. Do not hallucinate a ready tool or present partial coverage as comprehensive | Pending original owner PID 21808; proprietary QVX77 format with no format specification |
| P3-D | Synthetic source split across 2 shards | Real Pi Main invokes real parallel disposable Workers; recognizes both URL resolver and record-list as **conditional cooperating capabilities**; no claim they are installed | PASS at PID 5604, exit 0, Main/2 Workers, 2/2 shards; ~19.2 s total and ~4.1 s fanout tool duration |

For each run capture: exact input task and mode, source SHA, Pi version, PID, terminal status, shard coverage, final recommended path, whether prerequisites were actually checked, elapsed time, and available token usage. A zero-priced provider usage report **does not** establish free API calls. Do not treat a single successful scenario as statistical quality proof.

## Two-shard dogfood

`fixture-catalog.mjs` creates four **synthetic** capability descriptions. The deterministic planner groups them into exactly two shards at a **test-only 1100-byte budget**. The URL resolver and record-list belong to *different* shards. This intentionally keeps the real model run small while exercising Main → concurrent Workers → Main.

Run only when **no previous advisor PID is still active**:

```powershell
node runtime/evaluation/run-synthetic-e2e.mjs --execute-once
```

One command starts one owned RDC process, which starts one Pi Main and two disposable Pi Workers. It uses the existing, already configured dedicated Pi installation. The script requires the explicit `--execute-once` flag, makes **actual model calls**, and prints the final Main answer and aggregate token/latency data. It does not persist logs or repeat failed calls. Do not run it from CI or the normal `node --test` suite. If RDC reports that the process is running, retain that PID and reconcile it before another run.

The real Runtime still defaults to 256 KiB per Worker. A 2-shard synthetic test **does not prove** real-world performance at 256 KiB/shard or evaluate thousands of installed Skills. Those remain separate acceptance work.

## Unit/static suite

```powershell
node --test runtime/capabilities.test.mjs runtime/skill-hub.test.mjs runtime/pi-advisor-fanout.test.mjs runtime/evaluation/p3-evaluation.test.mjs runtime/evaluation/skill-hub-describe.test.mjs
```

The unit suite does not run the model dogfood. Scoring semantic answer quality requires review against the acceptance criterion, rather than keyword matching used to select tools.

## Safety and release boundary

Use a developer-owned Draft PR for source updates. Do not auto-merge, upgrade the installed runtime, change Plugin versions, sync `~/.agents/skills`, or write to the user's application repositories. This evaluation extension is loaded **only** by the explicit synthetic runner and cannot replace production `capability_fanout`.
