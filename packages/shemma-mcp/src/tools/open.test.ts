import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AutoOpenManager } from "../auto-open";
import { registerOpenTool } from "./open";

function setup(opts: { mode?: "never" | "once" | "always" | "confirm"; throwOnSpawn?: boolean } = {}) {
  const calls: string[] = [];
  const auto = new AutoOpenManager({
    mode: opts.mode ?? "never",
    env: {},
    spawn: async (r) => {
      if (opts.throwOnSpawn) throw new Error("spawn failed");
      calls.push(r);
    },
  });
  const server = new McpServer({ name: "t", version: "0" });
  const handles = registerOpenTool(server, { autoOpen: auto, defaultRoom: "default" });
  return { server, auto, handles, calls };
}

describe("shemma_open", () => {
  it("registers tool without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("explicit open with room arg spawns subprocess", async () => {
    const { handles, calls } = setup();
    const r = await handles.open.call({ room: "test-room" });
    expect(calls).toEqual(["test-room"]);
    expect(r.structuredContent).toMatchObject({ ok: true, room: "test-room", data: { spawned: true } });
  });

  it("uses defaultRoom when no room arg", async () => {
    const { handles, calls } = setup();
    const r = await handles.open.call({});
    expect(calls).toEqual(["default"]);
    expect(r.structuredContent).toMatchObject({ ok: true, room: "default" });
  });

  it("noBrowser:true skips spawn", async () => {
    const { handles, calls } = setup();
    const r = await handles.open.call({ noBrowser: true });
    expect(calls).toEqual([]);
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { spawned: false, reason: "noBrowser" },
    });
  });

  it("explicit open ignores mode (even never)", async () => {
    const { handles, calls } = setup({ mode: "never" });
    await handles.open.call({ room: "x" });
    expect(calls).toEqual(["x"]);
  });

  it("returns error when spawn throws", async () => {
    const { handles } = setup({ throwOnSpawn: true });
    const r = await handles.open.call({ room: "x" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, code: "unexpected-error" });
  });
});
