import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "@shemma/client";
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
};

export type ShemmaMcpServerHandle = {
  server: McpServer;
  meta: { name: string; version: string };
  opts: ShemmaMcpServerOpts;
};

export function createShemmaMcpServer(opts: ShemmaMcpServerOpts): ShemmaMcpServerHandle {
  const meta = { name: "shemma", version: SHEMMA_MCP_VERSION };
  const server = new McpServer({ name: meta.name, version: meta.version });
  return { server, meta, opts };
}
