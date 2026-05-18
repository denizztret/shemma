import { describe, expect, it } from "bun:test";
import { CanvasClient } from "@shemma/client";
import { createShemmaMcpServer } from "./server";

describe("stdio purity (§11.5)", () => {
  it("createShemmaMcpServer does not write to stdout", () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const client = new CanvasClient({ baseUrl: "http://test" });
      createShemmaMcpServer({
        client,
        defaultRoom: "default",
        profile: "release",
        discoverInProgress: async () => [],
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured.join("")).toBe("");
  });
});
