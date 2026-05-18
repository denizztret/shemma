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

/**
 * Fix project working directory for ALL subsequent subprocess spawns
 * (backlog-discovery `Bun.spawn(["backlog",...])`, auto-open
 * `Bun.spawn(["shemma","open",...])`). MCP clients (esp. Claude Desktop)
 * spawn this process from $HOME or unpredictable cwd; without chdir, downstream
 * subprocesses inherit the wrong cwd. See spec §4.4.
 *
 * Graceful fallback: if projectDir doesn't exist or chdir fails, emit stderr
 * warning and continue with inherited cwd (room-resolver step 5 may skip;
 * other paths still work). See spec §4.4 graceful degradation.
 */
export function chdirToProjectDir(projectDir: string): void {
  try {
    process.chdir(projectDir);
  } catch (e) {
    process.stderr.write(
      `shemma mcp: SHEMMA_CWD/${projectDir} not accessible (${(e as Error).message}); continuing with inherited cwd\n`,
    );
  }
}

export async function startStdio(opts: StartOpts): Promise<void> {
  chdirToProjectDir(opts.projectDir);
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
