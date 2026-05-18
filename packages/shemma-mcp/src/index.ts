import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "@shemma/client";
import { createShemmaMcpServer, type Profile } from "./server";

export { createShemmaMcpServer } from "./server";
export { SHEMMA_MCP_VERSION } from "./version";

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
  // TODO(Task 20): wire registerResources(server, {...}) and tool registrations
  // (registerInstructionsTool, registerReadOnlyTools, ...) before connecting.
  // Until Task 20 lands, this stdio entry exposes a server with zero capabilities —
  // usable as a smoke test for the SDK transport but not for any agent work.
  await server.connect(transport);
}
