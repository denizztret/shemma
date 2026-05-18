import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { portFor } from "./profile";

export type AutoOpenMode = "never" | "once" | "always" | "confirm";

export type McpStartFlags = {
  profile?: "dev" | "release" | "debug";
  cwd?: string;
  room?: string;
  baseUrl?: string;
  autoOpenMode: AutoOpenMode;
  noAutoEnsure: boolean;
};

export function parseMcpStartFlags(argv: string[]): McpStartFlags {
  const out: McpStartFlags = { autoOpenMode: "once", noAutoEnsure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--room") out.room = argv[++i];
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

// ---------------------------------------------------------------------------
// Detection & refresh helpers
// ---------------------------------------------------------------------------

export type DetectedMcpClient = {
  client: "claude" | "codex";
  path: string;
  hasShemma: boolean;
};

type DetectOpts = {
  homeDir?: string;
  platform?: NodeJS.Platform;
};

function claudeConfigPathFor(homeDir: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(homeDir, ".config", "Claude", "claude_desktop_config.json");
}

function codexConfigPathFor(homeDir: string): string {
  return join(homeDir, ".codex", "config.toml");
}

export function detectInstalledMcpConfigs(opts: DetectOpts = {}): DetectedMcpClient[] {
  const home = opts.homeDir ?? homedir();
  const platform = opts.platform ?? process.platform;
  const out: DetectedMcpClient[] = [];

  const claudePath = claudeConfigPathFor(home, platform);
  if (existsSync(claudePath)) {
    let hasShemma = false;
    try {
      const j = JSON.parse(readFileSync(claudePath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      hasShemma = Boolean(j.mcpServers && "shemma" in j.mcpServers);
    } catch {
      // malformed JSON — treat as no shemma entry
    }
    out.push({ client: "claude", path: claudePath, hasShemma });
  }

  const codexPath = codexConfigPathFor(home);
  if (existsSync(codexPath)) {
    let hasShemma = false;
    try {
      hasShemma = readFileSync(codexPath, "utf8").includes("[mcp_servers.shemma]");
    } catch {
      // unreadable — treat as no shemma entry
    }
    out.push({ client: "codex", path: codexPath, hasShemma });
  }

  return out;
}

export type RefreshOpts = {
  homeDir?: string;
  platform?: NodeJS.Platform;
  projectDir: string;
};

export type RefreshResult = {
  refreshed: ("claude" | "codex")[];
  skipped: ("claude" | "codex")[];
};

export function refreshMcpConfigs(opts: RefreshOpts): RefreshResult {
  const detected = detectInstalledMcpConfigs({ homeDir: opts.homeDir, platform: opts.platform });
  const refreshed: ("claude" | "codex")[] = [];
  const skipped: ("claude" | "codex")[] = [];

  for (const entry of detected) {
    if (!entry.hasShemma) {
      skipped.push(entry.client);
      continue;
    }
    const snippet =
      entry.client === "claude"
        ? JSON.stringify(
            {
              mcpServers: {
                shemma: {
                  command: "shemma",
                  args: ["mcp", "start", "--cwd", opts.projectDir],
                },
              },
            },
            null,
            2,
          )
        : `[mcp_servers.shemma]\ncommand = "shemma"\nargs = ["mcp", "start", "--cwd", "${opts.projectDir}"]\n`;
    writeFileSync(`${entry.path}.bak.${Date.now()}`, readFileSync(entry.path));
    writeFileSync(entry.path, snippet);
    refreshed.push(entry.client);
  }

  return { refreshed, skipped };
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
    projectDir: flags.cwd ?? process.cwd(),
    autoOpenMode: flags.autoOpenMode,
  });
}

