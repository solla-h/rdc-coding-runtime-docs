import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSyntheticTwoShardPlan } from "./fixture-catalog.mjs";
import {
  buildPiWorkerInvocation, invokePiWorker, runParallelAdvisor,
} from "../lib/pi-advisor-fanout.mjs";

let cached: Promise<unknown> | null = null;

export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "capability_fanout",
    label: "Synthetic two-shard Pi Advisor dogfood",
    description: [
      "EVALUATION ONLY. Calls two actual disposable Pi Workers in parallel, each",
      "receiving every complete description in one isolated synthetic fixture shard.",
      "The fixture contains no installed Skills, credentials, or real service calls.",
      "Call exactly once per task and synthesize both shards' matching suggestions.",
      "Never imply fixture paths prove local capabilities are installed.",
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({ description: "Read-only task goal and constraints" }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!cached) {
        cached = (async () => {
          const script = process.env.RDC_PI_WORKER_SCRIPT;
          const model = process.env.RDC_ADVISOR_WORKER_MODEL;
          const thinking = process.env.RDC_ADVISOR_WORKER_THINKING;
          if (!script || !model || !thinking) throw new Error("Pi worker configuration missing");
          const invocation = buildPiWorkerInvocation({ piScript: script, model, thinking });
          const shardPlan = buildSyntheticTwoShardPlan();
          const deadline = Number(process.env.RDC_ADVISOR_DEADLINE_MS);
          const deadlineMs = Number.isFinite(deadline) && deadline > Date.now() ?
            deadline : Date.now() + 180000;
          return await runParallelAdvisor({
            task: params.task, shardPlan, signal,
            deadlineMs, perWorkerTimeoutMs: 100000,
            invokeWorker: ({ prompt, timeoutMs, signal }) => invokePiWorker({
              invocation, prompt, timeoutMs, signal, cwd: ctx.cwd,
              env: process.env,
            }),
          });
        })().catch(error => ({
          schema: 1, status: "failed",
          reason: "synthetic_fanout_failed",
          diagnostic: String(error?.message || error).slice(0, 240),
        }));
      }
      const result = await cached;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  }));
}
