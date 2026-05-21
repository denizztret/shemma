import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerSpace } from "@shemma/spaces";
import { spaceMiddleware } from "../middleware/space";

let tmpXdg: string;
let tmpProject: string;
let origXdg: string | undefined;
let app: Hono;

beforeEach(() => {
  // Isolate registry I/O to a fresh XDG_CONFIG_HOME per test so we never
  // touch the user's real ~/.config/shemma/spaces.json.
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-mw-xdg-"));
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-mw-proj-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;

  app = new Hono();
  app.use("/api/*", spaceMiddleware());
  app.get("/api/echo", (c) => {
    const space = c.get("space");
    return c.json({ id: space.id, path: space.path });
  });
});

afterEach(() => {
  process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("spaceMiddleware", () => {
  it("400 when space query param missing", async () => {
    const resp = await app.fetch(new Request("http://x/api/echo"));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("space_required");
  });

  it("400 when space id malformed", async () => {
    const resp = await app.fetch(new Request("http://x/api/echo?space=BAD!"));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("invalid_space_id");
  });

  it("404 when space id syntactically valid but unknown", async () => {
    const resp = await app.fetch(
      new Request("http://x/api/echo?space=unknown-id"),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string; id: string };
    expect(body.error).toBe("space_not_found");
    expect(body.id).toBe("unknown-id");
  });

  it("200 + space on context when id resolves in registry", async () => {
    const { space } = registerSpace(tmpProject);
    const resp = await app.fetch(
      new Request(`http://x/api/echo?space=${space.id}`),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: string; path: string };
    expect(body.id).toBe(space.id);
    expect(body.path).toBe(fs.realpathSync(tmpProject));
  });

  it("falls back to 'default' space when no ?space= and default exists", async () => {
    // DRW-116 §6.4: legacy clients without ?space= must transparently land
    // on the registered `default` space — instead of getting a 400.
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "def-"));
    try {
      registerSpace(proj, { id: "default" });
      const resp = await app.fetch(new Request("http://x/api/echo"));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { id: string };
      expect(body.id).toBe("default");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it("bypasses validation for allowlisted paths", async () => {
    const guarded = new Hono();
    guarded.use(
      "/api/*",
      spaceMiddleware({ allowList: new Set(["/api/health"]) }),
    );
    guarded.get("/api/health", (c) => c.json({ ok: true }));
    const resp = await guarded.fetch(new Request("http://x/api/health"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
