import os from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planSkillHub } from "./lib/skill-hub.mjs";
import { shardHubSelection } from "./lib/capability-shards.mjs";
import {
  buildPiWorkerInvocation, invokePiWorker, runParallelAdvisor,
} from "./lib/pi-advisor-fanout.mjs";

let cached: Promise<unknown> | null = null;

function response(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

export default function(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "capability_fanout",
    label: "Evaluate local capabilities with parallel Pi workers",
    description: [
      "For an unfamiliar local Skill decision, evaluate EVERY Skill Hub candidate across",
      "isolated, short-lived Pi worker contexts. Each worker receives the complete",
      "name and description of every candidate in its deterministic shard.",
      "This tool produces evidence-backed shortlist suggestions, not execution.",
      "Call once per task and synthesize cross-shard results. Do not interpret a failed shard",
      "as no match. No file changes, package installs, or business calls are performed.",
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({ description: "Bounded task capsule with goal, workspace and constraints" }),
      parallelism: Type.Optional(Type.Number({
        description: "Maximum simultaneous Pi workers (1, 2, 4 or 8); default 4",
      })),
      targetBytes: Type.Optional(Type.Number({
        description: "Candidate metadata bytes per worker, default 262144",
      })),
    }),
    async execute(_callId, params, signal, _update, ctx) {
      if (cached) return response(await cached);
      const parallelism = params.parallelism ?? 4;
      const targetBytes = params.targetBytes ?? 262144;
      if (![1, 2, 4, 8].includes(parallelism)) {
        return response({ status: "failed", reason: "parallelism must be 1, 2, 4 or 8" });
      }
      if (!Number.isSafeInteger(targetBytes) || targetBytes < 262144 || targetBytes > 512 * 1024) {
        return response({ status: "failed", reason: "targetBytes must be 262144..524288" });
      }
      const script = process.env.RDC_PI_WORKER_SCRIPT;
      const model = process.env.RDC_ADVISOR_WORKER_MODEL;
      const thinking = process.env.RDC_ADVISOR_WORKER_THINKING;
      if (!script || !model || !thinking) {
        return response({ status: "failed", reason: "Pi worker configuration unavailable" });
      }
      const workspace = process.env.RDC_ADVISOR_WORKSPACE || ctx.cwd || process.cwd();
      cached = (async () => {
        const catalog = planSkillHub({ home: os.homedir() });
        if (!catalog.canSync) return {
          schema: 1, status: "incomplete", reason: "skill_hub_source_incomplete_or_conflicting",
          blocked: catalog.blocked, incompleteSources: catalog.incompleteSources,
          diagnostics: catalog.diagnostics,
        };
        const plan = shardHubSelection(catalog, { targetBytes, parallelism });
        const invocation = buildPiWorkerInvocation({ piScript: script, model, thinking });
        const advertised = Number(process.env.RDC_ADVISOR_DEADLINE_MS);
        const deadlineMs = Number.isFinite(advertised) && advertised > Date.now() ?
          Math.min(advertised, Date.now() + 280_000) : Date.now() + 280_000;
        return runParallelAdvisor({
          task: params.task, shardPlan: plan, signal, deadlineMs,
          invokeWorker: ({ prompt, timeoutMs, signal }) => invokePiWorker({
            invocation, prompt, timeoutMs, signal,
            cwd: workspace, env: process.env,
          }),
        });
      })().catch(error => ({
        schema: 1, status: "failed",
        reason: "fanout_failed", diagnostic: String(error.message || error).slice(0, 300),
      }));
      return response(await cached);
    },
  }));
}
