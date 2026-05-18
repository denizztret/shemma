import { portFor } from "./profile";

export type AutoOpenMode = "never" | "once" | "always" | "confirm";

export type McpStartFlags = {
  profile?: "dev" | "release" | "debug";
  room?: string;
  baseUrl?: string;
  autoOpenMode: AutoOpenMode;
  noAutoEnsure: boolean;
};

export function parseMcpStartFlags(argv: string[]): McpStartFlags {
  const out: McpStartFlags = { autoOpenMode: "once", noAutoEnsure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") {
      throw new Error(
        "the --cwd flag was removed in 0.14.0. " +
          "Set SHEMMA_CWD env var instead (in your MCP client config or shell). " +
          "See docs/mcp.md → \"Setup\" for the new manual config snippet.",
      );
    }
    if (a === "--room") out.room = argv[++i];
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--no-auto-ensure") out.noAutoEnsure = true;
    else if (a === "--profile") {
      const v = argv[++i];
      if (v !== "dev" && v !== "release" && v !== "debug") {
        throw new Error(`invalid --profile: ${v}`);
      }
      out.profile = v;
    } else if (a === "--auto-open") {
      const v = argv[++i];
      if (!["never", "once", "always", "confirm"].includes(v)) {
        throw new Error(`invalid --auto-open value: ${v}; expected never|once|always|confirm`);
      }
      out.autoOpenMode = v as AutoOpenMode;
    }
  }
  return out;
}

function resolveProjectDir(): string {
  const env = process.env.SHEMMA_CWD;
  if (env !== undefined) {
    const trimmed = env.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return process.cwd();
}

export async function cmdMcpStart(argv: string[]): Promise<void> {
  const flags = parseMcpStartFlags(argv);
  const profile = flags.profile ?? "release";
  // Lazy-load @shemma/mcp so non-mcp invocations don't pay the cost.
  const { startStdio } = await import("@shemma/mcp");
  await startStdio({
    profile,
    baseUrl: flags.baseUrl ?? `http://localhost:${portFor(profile)}`,
    defaultRoom: flags.room ?? "default",
    projectDir: resolveProjectDir(),
    autoOpenMode: flags.autoOpenMode,
  });
}
