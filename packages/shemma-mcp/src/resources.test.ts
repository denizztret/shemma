import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { registerResources, loadWorkflowMarkdown, WORKFLOW_TOPICS } from "./resources";

/** Minimal stub that overrides getHealth/getActiveRooms without real network calls. */
function makeClientStub(
  healthOverride: Awaited<ReturnType<CanvasClient["getHealth"]>> = null,
): CanvasClient {
  const client = new CanvasClient({ baseUrl: "http://test-stub" });
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (client as any).getHealth = async () => healthOverride;
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (client as any).getActiveRooms = async () => ({ rooms: [] });
  return client;
}

function makeServer() {
  return new McpServer({ name: "test", version: "0.0.0" });
}

describe("registerResources", () => {
  it("registers all 5 workflow resources", () => {
    const server = makeServer();
    const client = new CanvasClient({ baseUrl: "http://test" });
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    const names = summary.workflow.map((r) => r.uri);
    expect(names).toEqual([
      "shemma://workflow/overview",
      "shemma://workflow/read-context",
      "shemma://workflow/draw-architecture",
      "shemma://workflow/resolve-prompts",
      "shemma://workflow/trust-model",
    ]);
  });

  it("registers status + rooms + active-rooms", () => {
    const server = makeServer();
    const client = new CanvasClient({ baseUrl: "http://test" });
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    expect(summary.direct.map((r) => r.uri)).toEqual([
      "shemma://status",
      "shemma://rooms",
      "shemma://active-rooms",
    ]);
  });

  it("registers room templates", () => {
    const server = makeServer();
    const client = new CanvasClient({ baseUrl: "http://test" });
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    expect(summary.templates.map((t) => t.template)).toEqual([
      "shemma://room/{room}/context",
      "shemma://room/{room}/context/geometry",
      "shemma://room/{room}/prompts/pending",
      "shemma://room/{room}/prompts/all",
      "shemma://room/{room}/state/compact",
      "shemma://room/{room}/state/full",
    ]);
  });

  it("reads workflow/overview returns markdown content", async () => {
    const server = makeServer();
    const client = new CanvasClient({ baseUrl: "http://test" });
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    const overview = summary.workflow.find((r) => r.uri === "shemma://workflow/overview");
    const content = await overview!.read();
    expect(content).toContain("Shemma");
    expect(content).toContain("Read-then-write loop");
  });

  it("status JSON includes daemon.pid when daemon is running (spec §7.4)", async () => {
    const server = makeServer();
    const client = makeClientStub({
      ok: true,
      profile: "release",
      storage: "/tmp/shemma",
      version: "0.0.0",
      pid: 12345,
    });
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    const statusResource = summary.direct.find((r) => r.uri === "shemma://status")!;
    const raw = await statusResource.read();
    const parsed = JSON.parse(raw);
    expect(parsed.daemon.running).toBe(true);
    expect(parsed.daemon.pid).toBe(12345);
    expect(typeof parsed.daemon.pid).toBe("number");
  });

  it("status JSON has running:false + reason:unreachable when daemon is down", async () => {
    const server = makeServer();
    const client = makeClientStub(null);
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    const statusResource = summary.direct.find((r) => r.uri === "shemma://status")!;
    const raw = await statusResource.read();
    const parsed = JSON.parse(raw);
    expect(parsed.daemon.running).toBe(false);
    expect(parsed.daemon.reason).toBe("unreachable");
  });

  it("status JSON uses provided projectDir instead of process.cwd()", async () => {
    const server = makeServer();
    const client = makeClientStub(null);
    const summary = registerResources(server, {
      client,
      defaultRoom: "default",
      profile: "release",
      projectDir: "/custom/project/dir",
    });
    const statusResource = summary.direct.find((r) => r.uri === "shemma://status")!;
    const raw = await statusResource.read();
    const parsed = JSON.parse(raw);
    expect(parsed.projectDir).toBe("/custom/project/dir");
  });

  it("status JSON serverVersion matches SHEMMA_MCP_VERSION", async () => {
    const { SHEMMA_MCP_VERSION } = await import("./version");
    const server = makeServer();
    const client = makeClientStub(null);
    const summary = registerResources(server, { client, defaultRoom: "default", profile: "release" });
    const statusResource = summary.direct.find((r) => r.uri === "shemma://status")!;
    const raw = await statusResource.read();
    const parsed = JSON.parse(raw);
    expect(typeof parsed.serverVersion).toBe("string");
    expect(parsed.serverVersion).toBe(SHEMMA_MCP_VERSION);
  });
});

describe("loadWorkflowMarkdown", () => {
  it.each(WORKFLOW_TOPICS)("reads %s and returns non-empty markdown", async (topic) => {
    const content = await loadWorkflowMarkdown(topic);
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });
});
