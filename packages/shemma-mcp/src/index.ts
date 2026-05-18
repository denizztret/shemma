import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "@shemma/client";
import { createShemmaMcpServer, type Profile } from "./server";

export { createShemmaMcpServer } from "./server";
export const SHEMMA_MCP_VERSION = "0.0.0";

export type StartOpts = {
  profile: Profile;
  baseUrl: string;
  defaultRoom: string;
  projectDir: string;
};

export async function startStdio(opts: StartOpts): Promise<void> {
  const client = new CanvasClient({ baseUrl: opts.baseUrl, room: opts.defaultRoom });
  const { server } = createShemmaMcpServer({
    client,
    defaultRoom: opts.defaultRoom,
    profile: opts.profile,
    baseUrl: opts.baseUrl,
    projectDir: opts.projectDir,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
