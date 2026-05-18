import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "@shemma/client";
import type { AutoOpenMode } from "./auto-open";
import { createShemmaMcpServer, type Profile } from "./server";
import { SHEMMA_MCP_VERSION } from "./version";

export { createShemmaMcpServer } from "./server";
export { SHEMMA_MCP_VERSION };

export type StartOpts = {
  profile: Profile;
  baseUrl: string;
  defaultRoom: string;
  projectDir: string;
  configRoom?: string;
  autoOpenMode?: AutoOpenMode;
};

export async function startStdio(opts: StartOpts): Promise<void> {
  const client = new CanvasClient({ baseUrl: opts.baseUrl, room: opts.defaultRoom });
  const { server } = createShemmaMcpServer({
    client,
    defaultRoom: opts.defaultRoom,
    profile: opts.profile,
    baseUrl: opts.baseUrl,
    projectDir: opts.projectDir,
    configRoom: opts.configRoom,
    autoOpenMode: opts.autoOpenMode,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
