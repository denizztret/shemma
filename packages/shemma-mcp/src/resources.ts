import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { Profile } from "./server";
import { SHEMMA_MCP_VERSION } from "./version";

const HERE = dirname(fileURLToPath(import.meta.url));

export const WORKFLOW_TOPICS = [
  "overview",
  "read-context",
  "draw-architecture",
  "resolve-prompts",
  "trust-model",
] as const;

export type WorkflowTopic = (typeof WORKFLOW_TOPICS)[number];

export function loadWorkflowMarkdown(topic: WorkflowTopic): string {
  return readFileSync(join(HERE, "workflow", `${topic}.md`), "utf8");
}

export type RegisterResourcesOpts = {
  client: CanvasClient;
  defaultRoom: string;
  profile: Profile;
  /** Captured project directory for status resource. Falls back to process.cwd() if omitted. */
  projectDir?: string;
};

export type RegisteredResource = { uri: string; read: () => Promise<string> };
// RegisteredTemplate intentionally omits a `read` method — templates require a
// room variable resolved at call time, so reads are dispatched via the SDK
// callback with URI variables rather than a parameterless thunk (cf. RegisteredResource).
export type RegisteredTemplate = { template: string };

export type ResourcesSummary = {
  workflow: RegisteredResource[];
  direct: RegisteredResource[];
  templates: RegisteredTemplate[];
};

export function registerResources(
  server: McpServer,
  opts: RegisterResourcesOpts,
): ResourcesSummary {
  const { client } = opts;
  const base = client.baseUrl;

  // ── Workflow markdowns ──────────────────────────────────────────────────────
  const workflow: RegisteredResource[] = [];
  for (const topic of WORKFLOW_TOPICS) {
    const uri = `shemma://workflow/${topic}`;
    const read = async () => loadWorkflowMarkdown(topic);
    server.registerResource(
      `workflow-${topic}`,
      uri,
      {
        title: `Workflow: ${topic}`,
        description: `Agent workflow guide — ${topic}`,
        mimeType: "text/markdown",
      },
      async () => {
        try {
          const text = await read();
          return { contents: [{ uri, mimeType: "text/markdown", text }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { contents: [{ uri, mimeType: "text/plain", text: `error loading ${topic}: ${msg}` }] };
        }
      },
    );
    workflow.push({ uri, read });
  }

  // ── Status ──────────────────────────────────────────────────────────────────
  const statusUri = "shemma://status";
  const statusRead = async (): Promise<string> => {
    const health = await client.getHealth().catch(() => null);
    const active = await client.getActiveRooms().catch(() => ({ rooms: [] }));
    return JSON.stringify({
      ok: true,
      serverVersion: SHEMMA_MCP_VERSION,
      cliVersion: health?.version ?? "unknown",
      profile: opts.profile,
      baseUrl: base,
      defaultRoom: opts.defaultRoom,
      suggestedRoom: opts.defaultRoom,
      projectDir: opts.projectDir ?? process.cwd(),
      daemon: health
        ? { running: true as const, pid: health.pid, healthy: true, storage: health.storage }
        // v1 always emits "unreachable"; spec §7.4 allows "not-started"/"unhealthy" —
        // refine in Task 20 when ensureDaemon wires in.
        : { running: false as const, reason: "unreachable" as const },
      rooms: {},
      activeRooms: active.rooms,
      autoOpen: { mode: "once" as const, openedRooms: [] as string[] },
    });
  };
  server.registerResource(
    "status",
    statusUri,
    { title: "Shemma status", mimeType: "application/json" },
    async () => ({
      contents: [{ uri: statusUri, mimeType: "application/json", text: await statusRead() }],
    }),
  );

  // ── Rooms ───────────────────────────────────────────────────────────────────
  const roomsUri = "shemma://rooms";
  const roomsRead = async (): Promise<string> => JSON.stringify(await client.listRooms());
  server.registerResource(
    "rooms",
    roomsUri,
    { title: "Rooms", mimeType: "application/json" },
    async () => ({
      contents: [{ uri: roomsUri, mimeType: "application/json", text: await roomsRead() }],
    }),
  );

  // ── Active rooms ────────────────────────────────────────────────────────────
  const activeUri = "shemma://active-rooms";
  const activeRead = async (): Promise<string> =>
    JSON.stringify(await client.getActiveRooms());
  server.registerResource(
    "active-rooms",
    activeUri,
    { title: "Active rooms", mimeType: "application/json" },
    async () => ({
      contents: [{ uri: activeUri, mimeType: "application/json", text: await activeRead() }],
    }),
  );

  // ── Room templates ──────────────────────────────────────────────────────────
  // SDK v1.x: new ResourceTemplate(uriPattern, { list }) + registerResource(name, template, meta, cb)
  // ReadResourceTemplateCallback receives (uri: URL, variables: Variables, extra)
  const TEMPLATE_DEFS: Array<{
    name: string;
    template: string;
    title: string;
    read: (room: string) => Promise<unknown>;
  }> = [
    {
      name: "room-context",
      template: "shemma://room/{room}/context",
      title: "Room context (compact)",
      read: (room) =>
        new CanvasClient({ baseUrl: base, room }).getContext(),
    },
    {
      name: "room-context-geometry",
      template: "shemma://room/{room}/context/geometry",
      title: "Room context with geometry",
      read: (room) =>
        new CanvasClient({ baseUrl: base, room }).getContext({ viewport: "all" }),
    },
    {
      name: "room-prompts-pending",
      template: "shemma://room/{room}/prompts/pending",
      title: "Room prompts (pending)",
      read: (room) =>
        new CanvasClient({ baseUrl: base, room }).getPrompts("pending"),
    },
    {
      name: "room-prompts-all",
      template: "shemma://room/{room}/prompts/all",
      title: "Room prompts (all)",
      read: (room) =>
        new CanvasClient({ baseUrl: base, room }).getPrompts("all"),
    },
    {
      name: "room-state-compact",
      template: "shemma://room/{room}/state/compact",
      title: "Room state (compact)",
      read: (room) =>
        new CanvasClient({ baseUrl: base, room }).getState({ fmt: "compact" }),
    },
    {
      name: "room-state-full",
      template: "shemma://room/{room}/state/full",
      title: "Room state (full)",
      read: (room) =>
        new CanvasClient({ baseUrl: base, room }).getState({ fmt: "full" }),
    },
  ];

  const templates: RegisteredTemplate[] = [];
  for (const def of TEMPLATE_DEFS) {
    const resourceTemplate = new ResourceTemplate(def.template, { list: undefined });
    server.registerResource(
      def.name,
      resourceTemplate,
      { title: def.title, mimeType: "application/json" },
      async (uri, variables) => {
        const room = String(variables["room"] ?? opts.defaultRoom);
        const data = await def.read(room).catch((err: unknown) => ({
          error: err instanceof Error ? err.message : String(err),
        }));
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(data),
            },
          ],
        };
      },
    );
    templates.push({ template: def.template });
  }

  return {
    workflow,
    direct: [
      { uri: statusUri, read: statusRead },
      { uri: roomsUri, read: roomsRead },
      { uri: activeUri, read: activeRead },
    ],
    templates,
  };
}
