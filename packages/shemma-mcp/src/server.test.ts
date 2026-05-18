import { describe, expect, it } from "bun:test";
import { createShemmaMcpServer } from "./server";
import { CanvasClient } from "@shemma/client";

describe("createShemmaMcpServer", () => {
  it("returns server with metadata", () => {
    const client = new CanvasClient({ baseUrl: "http://localhost:0" });
    const { server, meta } = createShemmaMcpServer({ client, defaultRoom: "default", profile: "release", discoverInProgress: async () => [] });
    expect(meta.name).toBe("shemma");
    expect(typeof meta.version).toBe("string");
    expect(server).toBeDefined();
  });
});

describe("createShemmaMcpServer integration", () => {
  it("returns resolver and autoOpen in handle", () => {
    const client = new CanvasClient({ baseUrl: "http://test" });
    const handle = createShemmaMcpServer({
      client,
      defaultRoom: "default",
      profile: "release",
      autoOpenMode: "once",
      discoverInProgress: async () => [],
    });
    expect(handle.resolver).toBeDefined();
    expect(handle.autoOpen).toBeDefined();
    expect(handle.autoOpen.snapshot().mode).toBe("once");
  });

  it("registers all tools without throwing", () => {
    const client = new CanvasClient({ baseUrl: "http://test" });
    expect(() =>
      createShemmaMcpServer({
        client,
        defaultRoom: "default",
        profile: "release",
        discoverInProgress: async () => [],
      }),
    ).not.toThrow();
  });

  it("default autoOpenMode is 'once'", () => {
    const client = new CanvasClient({ baseUrl: "http://test" });
    const handle = createShemmaMcpServer({
      client,
      defaultRoom: "default",
      profile: "release",
      discoverInProgress: async () => [],
    });
    expect(handle.autoOpen.snapshot().mode).toBe("once");
  });
});
