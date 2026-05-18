import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  detectInstalledMcpConfigs,
  parseMcpStartFlags,
  refreshMcpConfigs,
} from "./mcp";

describe("parseMcpStartFlags", () => {
  it("parses defaults", () => {
    const o = parseMcpStartFlags([]);
    expect(o).toMatchObject({ autoOpenMode: "once", noAutoEnsure: false });
  });
  it("parses --auto-open never", () => {
    expect(parseMcpStartFlags(["--auto-open", "never"]).autoOpenMode).toBe("never");
  });
  it("rejects invalid --auto-open", () => {
    expect(() => parseMcpStartFlags(["--auto-open", "wat"])).toThrow();
  });
  it("parses --no-auto-ensure", () => {
    expect(parseMcpStartFlags(["--no-auto-ensure"]).noAutoEnsure).toBe(true);
  });
  it("parses --cwd path", () => {
    expect(parseMcpStartFlags(["--cwd", "/tmp/x"]).cwd).toBe("/tmp/x");
  });
  it("parses --room id", () => {
    expect(parseMcpStartFlags(["--room", "abc"]).room).toBe("abc");
  });
  it("parses --base-url", () => {
    expect(parseMcpStartFlags(["--base-url", "http://x"]).baseUrl).toBe("http://x");
  });
});

describe("detectInstalledMcpConfigs", () => {
  it("returns empty when neither config exists", () => {
    const home = mkdtempSync(join(tmpdir(), "shemma-mcp-detect-"));
    const r = detectInstalledMcpConfigs({ homeDir: home });
    expect(r).toEqual([]);
  });

  it("detects claude config with shemma entry", () => {
    const home = mkdtempSync(join(tmpdir(), "shemma-mcp-detect-"));
    const dir = join(home, "Library/Application Support/Claude");
    mkdirSync(dir, { recursive: true });
    const cfg = { mcpServers: { shemma: { command: "shemma", args: ["mcp", "start"] } } };
    writeFileSync(join(dir, "claude_desktop_config.json"), JSON.stringify(cfg));
    const r = detectInstalledMcpConfigs({ homeDir: home, platform: "darwin" });
    expect(r).toHaveLength(1);
    expect(r[0]?.client).toBe("claude");
    expect(r[0]?.hasShemma).toBe(true);
  });

  it("detects codex config without shemma entry", () => {
    const home = mkdtempSync(join(tmpdir(), "shemma-mcp-detect-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.other]\ncommand = "x"\n`);
    const r = detectInstalledMcpConfigs({ homeDir: home, platform: "darwin" });
    const codex = r.find((e) => e.client === "codex");
    expect(codex).toBeDefined();
    expect(codex?.hasShemma).toBe(false);
  });
});

describe("refreshMcpConfigs", () => {
  it("rewrites only configs with existing shemma entry", () => {
    const home = mkdtempSync(join(tmpdir(), "shemma-mcp-refresh-"));
    const dir = join(home, "Library/Application Support/Claude");
    mkdirSync(dir, { recursive: true });
    const stale = { mcpServers: { shemma: { command: "/old/shemma", args: ["mcp", "start"] } } };
    writeFileSync(join(dir, "claude_desktop_config.json"), JSON.stringify(stale));
    const r = refreshMcpConfigs({ homeDir: home, projectDir: "/p", platform: "darwin" });
    expect(r.refreshed).toEqual(["claude"]);
    const fresh = JSON.parse(readFileSync(join(dir, "claude_desktop_config.json"), "utf8"));
    expect(fresh.mcpServers.shemma.command).toBe("shemma");
    expect(fresh.mcpServers.shemma.args).toEqual(["mcp", "start", "--cwd", "/p"]);
  });

  it("skips configs without shemma entry", () => {
    const home = mkdtempSync(join(tmpdir(), "shemma-mcp-refresh-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.other]\ncommand = "x"\n`);
    const r = refreshMcpConfigs({ homeDir: home, projectDir: "/p", platform: "darwin" });
    expect(r.refreshed).toEqual([]);
  });
});
