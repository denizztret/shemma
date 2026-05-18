import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { CanvasClient } from "@shemma/client";
import * as ServerModule from "./server";

// Mutable state captured across tests.
const captured: {
  callOrder: string[];
} = { callOrder: [] };

// Only mock the stdio transport — real `server.connect(transport)` would
// attach to process.stdin and hold the test process open. The transport is
// constructed AFTER createServer, so mocking it doesn't interfere with the
// ordering invariant we want to verify.
//
// Restored in afterAll so other test files in this bun:test process see the
// real transport. NOTE: this static module mock STILL leaks to other files
// loaded in the same process if not restored — afterAll re-mocks with real exports.
let realStdioTransport: typeof import("@modelcontextprotocol/sdk/server/stdio.js")["StdioServerTransport"];

describe("startStdio integration", () => {
  let originalCwd: string;
  let tempDir: string;
  let createServerSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    const realStdio = await import("@modelcontextprotocol/sdk/server/stdio.js");
    realStdioTransport = realStdio.StdioServerTransport;
    mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      // Bare stub — startStdio calls `new StdioServerTransport()` and then
      // `server.connect(transport)`, which in the real impl would attach to
      // process.stdin. We don't want that in tests.
      StdioServerTransport: class {},
    }));
  });

  afterAll(() => {
    mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: realStdioTransport,
    }));
  });

  beforeEach(() => {
    captured.callOrder = [];
    originalCwd = process.cwd();
    // realpathSync — on macOS /var/folders/... → /private/var/folders/...
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "shemma-mcp-cwd-")));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    createServerSpy?.mockRestore();
  });

  it("calls chdir BEFORE createServer + serverConnect (spec §4.4 ordering)", async () => {
    // Instrument chdir as a callOrder entry to verify it runs first.
    const realChdir = process.chdir.bind(process);
    process.chdir = ((p: string) => {
      captured.callOrder.push("chdir");
      return realChdir(p);
    }) as typeof process.chdir;

    // Instrument CanvasClient via subclass swap on the @shemma/client module.
    // Restored to the real module in `finally` so other test files in the
    // same bun:test process see the genuine class. mock.module is
    // process-global, so explicit restore is required.
    const ClientModule = await import("@shemma/client");
    class InstrumentedClient extends CanvasClient {
      constructor(opts: ConstructorParameters<typeof CanvasClient>[0]) {
        captured.callOrder.push("newCanvasClient");
        super(opts);
      }
    }
    mock.module("@shemma/client", () => ({
      CanvasClient: InstrumentedClient,
    }));

    createServerSpy = spyOn(ServerModule, "createShemmaMcpServer").mockImplementation(
      (_opts: unknown) => {
        captured.callOrder.push("createServer");
        return {
          server: {
            connect: async (_transport: unknown) => {
              captured.callOrder.push("serverConnect");
            },
            // Minimal type satisfaction for the rest of the handle.
          } as unknown as ReturnType<typeof ServerModule.createShemmaMcpServer>["server"],
          meta: { name: "shemma", version: "0.0.0" },
          resolver: {} as ReturnType<typeof ServerModule.createShemmaMcpServer>["resolver"],
          autoOpen: {} as ReturnType<typeof ServerModule.createShemmaMcpServer>["autoOpen"],
          opts: {} as ReturnType<typeof ServerModule.createShemmaMcpServer>["opts"],
        };
      },
    );

    try {
      const { startStdio } = await import("./index");
      await startStdio({
        profile: "release",
        baseUrl: "http://localhost:8787",
        defaultRoom: "default",
        projectDir: tempDir,
      });
    } finally {
      process.chdir = realChdir;
      // Restore @shemma/client so subsequent tests / files see the real export.
      mock.module("@shemma/client", () => ClientModule);
    }

    // Assert exact order: chdir → CanvasClient ctor → createServer → server.connect.
    expect(captured.callOrder).toEqual([
      "chdir",
      "newCanvasClient",
      "createServer",
      "serverConnect",
    ]);
  });

  it("after startStdio, process.cwd() equals projectDir (subprocess spawn invariant)", async () => {
    // Real-world invariant: backlog-discovery + auto-open spawn without explicit
    // cwd inherit THIS cwd. Without chdir — fall back to $HOME.
    createServerSpy = spyOn(ServerModule, "createShemmaMcpServer").mockImplementation(
      (_opts: unknown) => ({
        server: {
          connect: async () => {},
        } as unknown as ReturnType<typeof ServerModule.createShemmaMcpServer>["server"],
        meta: { name: "shemma", version: "0.0.0" },
        resolver: {} as ReturnType<typeof ServerModule.createShemmaMcpServer>["resolver"],
        autoOpen: {} as ReturnType<typeof ServerModule.createShemmaMcpServer>["autoOpen"],
        opts: {} as ReturnType<typeof ServerModule.createShemmaMcpServer>["opts"],
      }),
    );

    const { startStdio } = await import("./index");
    await startStdio({
      profile: "release",
      baseUrl: "http://localhost:8787",
      defaultRoom: "default",
      projectDir: tempDir,
    });
    expect(process.cwd()).toBe(tempDir);
  });
});
