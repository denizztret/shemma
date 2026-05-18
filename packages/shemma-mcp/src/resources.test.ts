import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { registerResources } from "./resources";

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
});
