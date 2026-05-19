import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadWorkflowMarkdown, WORKFLOW_TOPICS, type WorkflowTopic } from "../resources";

export type ToolHandle<I, O> = { call: (input: I) => Promise<O> };

export function registerInstructionsTool(
  server: McpServer,
): ToolHandle<{ topic?: string }, { content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const inputSchema = { topic: z.string().optional() };

  async function call(input: { topic?: string }) {
    const topic = (input.topic ?? "overview") as WorkflowTopic;
    if (!(WORKFLOW_TOPICS as readonly string[]).includes(topic)) {
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              code: "validation-error",
              message: `Unknown topic: ${input.topic}; valid: ${WORKFLOW_TOPICS.join(", ")}`,
            }),
          },
        ],
      };
    }
    try {
      const text = await loadWorkflowMarkdown(topic);
      return { content: [{ type: "text" as const, text }] };
    } catch {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, code: "instructions-unavailable", message: "workflow asset not bundled — please file an issue" }) }],
      };
    }
  }

  server.registerTool(
    "shemma_get_instructions",
    {
      description: "Return workflow guidance markdown (overview, read-context, draw-architecture, resolve-prompts, trust-model). Mirror of shemma://workflow/* resources for clients without resource support.",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => call(args as { topic?: string }),
  );

  return { call };
}
