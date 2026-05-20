import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "@shemma/client";
import { AutoOpenManager, defaultOpenSpawn, type AutoOpenMode } from "./auto-open";
import { discoverInProgressTasks, runBacklogCli } from "./backlog-discovery";
import { registerResources } from "./resources";
import { RoomResolver } from "./room-resolver";
import { registerMcpPrompts } from "./prompts-templates";
import { registerDomainTools } from "./tools/domain";
import { registerInstructionsTool } from "./tools/instructions";
import { registerOpenTool } from "./tools/open";
import { registerExportMiroTool } from "./tools/export-miro";
import { registerPromptAndActivityTools } from "./tools/prompts";
import { registerReadOnlyTools } from "./tools/read-only";
import { SHEMMA_MCP_VERSION } from "./version";

export type Profile = "dev" | "release" | "debug";

export type ShemmaMcpServerOpts = {
  client: CanvasClient;
  defaultRoom: string;
  profile: Profile;
  /** Resolved baseUrl (для status resource). */
  baseUrl?: string;
  /** Project dir (для status). */
  projectDir?: string;
  configRoom?: string;
  sessionEnv?: string;
  autoOpenMode?: AutoOpenMode;
  /** Test override: skip backlog subprocess. */
  discoverInProgress?: () => Promise<Array<{ id: string; slug: string }>>;
};

export type ShemmaMcpServerHandle = {
  server: McpServer;
  meta: { name: string; version: string };
  resolver: RoomResolver;
  autoOpen: AutoOpenManager;
  opts: ShemmaMcpServerOpts;
};

export function createShemmaMcpServer(opts: ShemmaMcpServerOpts): ShemmaMcpServerHandle {
  const meta = { name: "shemma", version: SHEMMA_MCP_VERSION };
  const server = new McpServer({ name: meta.name, version: meta.version });

  const autoOpen = new AutoOpenManager({
    mode: opts.autoOpenMode ?? "once",
    spawn: defaultOpenSpawn,
    env: process.env,
  });

  const resolver = new RoomResolver({
    configRoom: opts.configRoom,
    sessionEnv: opts.sessionEnv ?? process.env.CLAUDE_SESSION_ID,
    getActiveRooms: () => opts.client.getActiveRooms(),
    getInProgressTasks:
      opts.discoverInProgress ??
      (() => discoverInProgressTasks({ env: process.env, runBacklog: runBacklogCli })),
  });

  registerResources(server, {
    client: opts.client,
    defaultRoom: opts.defaultRoom,
    profile: opts.profile,
    projectDir: opts.projectDir,
  });
  registerInstructionsTool(server);
  registerReadOnlyTools(server, { client: opts.client, defaultRoom: opts.defaultRoom });
  registerDomainTools(server, {
    client: opts.client,
    resolver,
    defaultRoom: opts.defaultRoom,
    autoOpen,
  });
  registerPromptAndActivityTools(server, { client: opts.client, defaultRoom: opts.defaultRoom });
  registerOpenTool(server, { autoOpen, defaultRoom: opts.defaultRoom });
  registerExportMiroTool(server, {
    client: opts.client,
    resolver,
    defaultRoom: opts.defaultRoom,
  });
  registerMcpPrompts(server);

  return { server, meta, resolver, autoOpen, opts };
}
