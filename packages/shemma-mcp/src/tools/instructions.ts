import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadWorkflowMarkdown, type WorkflowTopic } from "../resources";

const VALID_TOPICS: WorkflowTopic[] = [
  "overview",
  "read-context",
  "draw-architecture",
  "resolve-prompts",
  "trust-model",
];

export type ToolHandle<I, O> = { call: (input: I) => Promise<O> };

export function registerInstructionsTool(
  server: McpServer,
): ToolHandle<{ topic?: string }, { content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const inputSchema = { topic: z.string().optional() };

  async function call(input: { topic?: string }) {
    const topic = (input.topic ?? "overview") as WorkflowTopic;
    if (!VALID_TOPICS.includes(topic)) {
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              code: "validation-error",
              message: `Unknown topic: ${input.topic}; valid: ${VALID_TOPICS.join(", ")}`,
            }),
          },
        ],
      };
    }
    const text = loadWorkflowMarkdown(topic);
    return { content: [{ type: "text" as const, text }] };
  }

  server.registerTool(
    "shemma_get_instructions",
    {
      description: "Return workflow guidance markdown (overview, read-context, draw-architecture, resolve-prompts, trust-model). Mirror of shemma://workflow/* resources for clients without resource support.",
      inputSchema,
    },
    async (args) => call(args as { topic?: string }),
  );

  return { call };
}
