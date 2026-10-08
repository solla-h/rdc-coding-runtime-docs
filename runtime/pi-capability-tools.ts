import { Type } from "@earendil-works/pi-ai";
import { describeHubSelectedSkill } from "./lib/skill-hub-describe.mjs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildContextSnapshot,
  describeCapability,
  findCapabilityMatches,
} from "./lib/capabilities.mjs";

function workspaceFrom(ctx: { cwd?: string }) {
  return process.env.RDC_ADVISOR_WORKSPACE || ctx.cwd || process.cwd();
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

const capabilityContext = defineTool({
  name: "capability_context",
  label: "Capability context",
  description: "Return bounded deterministic local capability evidence for the current RDC advisor workspace. The catalog is unranked; use semantic reasoning to decide relevance.",
  parameters: Type.Object({}),  async execute(_id, _params, _signal, _update, ctx) {
    const workspace = workspaceFrom(ctx);
    const snapshot = buildContextSnapshot({
      workspace,
      query: "Pi capability advisor evidence",
      maxItems: 180,
      maxBytes: 64 * 1024,
    });
    return textResult(snapshot);
  },
});

const capabilityDescribe = defineTool({
  name: "capability_describe",
  label: "Describe capability",
  description: "Re-resolve one exact capability ID and return current instructions. Supports IDs from capability_context and exact virtual skill:hub:<name> IDs returned by capability_fanout. This performs no semantic lookup.",
  parameters: Type.Object({
    id: Type.String({ description: "Exact stable capability ID" }),
  }),
  async execute(_callId, params, _signal, _update, ctx) {
    const workspace = workspaceFrom(ctx);
    if (/^skill:hub:/i.test(params.id)) {
      return textResult(describeHubSelectedSkill(params.id, {
        maxSkillContentChars: 18000,
      }));
    }
    return textResult(describeCapability(params.id, {
      workspace,
      maxSkillContentChars: 18000,
    }));
  },
});const commandResolve = defineTool({
  name: "command_resolve",
  label: "Resolve command",
  description: "Verify one exact CLI executable name against live PATH evidence. This does not execute the command or infer names from prose.",
  parameters: Type.Object({
    name: Type.String({ description: "Exact executable name, for example docsify or git" }),
  }),
  async execute(_callId, params, _signal, _update, ctx) {
    const workspace = workspaceFrom(ctx);
    const result = findCapabilityMatches(params.name, { workspace });
    const commands = result.matches.filter(item => item.kind === "command");
    return textResult({
      lookup: params.name,
      matches: commands,
      coverage: result.coverage,
      semanticSelectionPerformed: false,
    });
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(capabilityContext);
  pi.registerTool(capabilityDescribe);
  pi.registerTool(commandResolve);
}
