import { describe, expect, it } from "bun:test";
import { createShemmaMcpServer } from "./server";
import { CanvasClient } from "@shemma/client";

describe("createShemmaMcpServer", () => {
  it("returns server with metadata", () => {
    const client = new CanvasClient({ baseUrl: "http://localhost:0" });
    const { server, meta } = createShemmaMcpServer({ client, defaultRoom: "default", profile: "release" });
    expect(meta.name).toBe("shemma");
    expect(typeof meta.version).toBe("string");
    expect(server).toBeDefined();
  });
});
