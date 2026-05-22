import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeApp } from "../index";

let tmpXdg: string;
let origXdg: string | undefined;
let app: ReturnType<typeof makeApp>["app"];

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "spaces-routes-xdg-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  app = makeApp({ inMemory: true }).app;
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("GET /api/spaces", () => {
  it("returns empty list initially", async () => {
    const resp = await app.fetch(new Request("http://localhost/api/spaces"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { spaces: unknown[] };
    expect(body.spaces).toEqual([]);
  });

  it("returns LocalDTO for localhost client (host header carries path + storageLayout)", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const reg = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      expect(reg.status).toBe(200);
      const list = await app.fetch(new Request("http://localhost/api/spaces"));
      const body = (await list.json()) as {
        spaces: Array<{ id: string; path?: string; storageLayout?: string }>;
      };
      expect(body.spaces).toHaveLength(1);
      expect(body.spaces[0]).toHaveProperty("path");
      expect(body.spaces[0]).toHaveProperty("storageLayout");
      expect(body.spaces[0]!.path).toBe(fs.realpathSync(tmpProj));
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it("returns PublicDTO (no path) when host header is non-loopback", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      const list = await app.fetch(
        new Request("http://example.com/api/spaces"),
      );
      const body = (await list.json()) as {
        spaces: Array<{ id: string; path?: string; storageLayout?: string }>;
      };
      expect(body.spaces).toHaveLength(1);
      expect(body.spaces[0]!.path).toBeUndefined();
      expect(body.spaces[0]!.storageLayout).toBeUndefined();
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});

describe("POST /api/spaces", () => {
  it("creates space and returns created:true", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const resp = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj, label: "Test" }),
        }),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        space: { path: string; label: string };
        created: boolean;
      };
      expect(body.created).toBe(true);
      expect(body.space.path).toBe(fs.realpathSync(tmpProj));
      expect(body.space.label).toBe("Test");
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it("is idempotent on same path (created:false on second POST)", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      const resp2 = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      expect(resp2.status).toBe(200);
      const body = (await resp2.json()) as { created: boolean };
      expect(body.created).toBe(false);
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it("rejects empty body (path missing)", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("path_required");
  });

  it("rejects non-string path", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: 42 }),
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects non-existent path (ENOENT → path_not_found)", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/nonexistent/path/here" }),
      }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("path_not_found");
  });

  it("rejects malformed JSON body", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });
});

describe("GET /api/spaces/:id", () => {
  it("returns 404 for unknown id", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces/unknown"),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("space_not_found");
  });

  it("returns LocalDTO when id resolves and host is localhost", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const reg = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      const { space } = (await reg.json()) as { space: { id: string } };
      const get = await app.fetch(
        new Request(`http://localhost/api/spaces/${space.id}`),
      );
      expect(get.status).toBe(200);
      const body = (await get.json()) as {
        space: { id: string; path?: string };
      };
      expect(body.space.id).toBe(space.id);
      expect(body.space.path).toBe(fs.realpathSync(tmpProj));
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});

describe("DELETE /api/spaces/:id", () => {
  it("removes registered space", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const reg = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      const { space } = (await reg.json()) as { space: { id: string } };
      const del = await app.fetch(
        new Request(`http://localhost/api/spaces/${space.id}`, {
          method: "DELETE",
        }),
      );
      expect(del.status).toBe(200);
      const get = await app.fetch(
        new Request(`http://localhost/api/spaces/${space.id}`),
      );
      expect(get.status).toBe(404);
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it("is idempotent: 200 even when id never existed", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces/never-existed", {
        method: "DELETE",
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("PATCH /api/spaces/:id", () => {
  it("updates label", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const reg = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      const { space } = (await reg.json()) as { space: { id: string } };
      const patch = await app.fetch(
        new Request(`http://localhost/api/spaces/${space.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "NewLabel" }),
        }),
      );
      expect(patch.status).toBe(200);
      const body = (await patch.json()) as { space: { label: string } };
      expect(body.space.label).toBe("NewLabel");
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it("returns 400 when label missing", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const reg = await app.fetch(
        new Request("http://localhost/api/spaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tmpProj }),
        }),
      );
      const { space } = (await reg.json()) as { space: { id: string } };
      const patch = await app.fetch(
        new Request(`http://localhost/api/spaces/${space.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(patch.status).toBe(400);
      const body = (await patch.json()) as { error: string };
      expect(body.error).toBe("label_required");
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it("returns 404 when id unknown", async () => {
    const patch = await app.fetch(
      new Request("http://localhost/api/spaces/never-existed", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "X" }),
      }),
    );
    expect(patch.status).toBe(404);
  });
});

describe("POST /api/spaces/:id/reveal", () => {
  it("returns 404 for unknown id", async () => {
    const resp = await app.fetch(
      new Request("http://localhost/api/spaces/unknown/reveal", {
        method: "POST",
      }),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("space_not_found");
  });

  it("returns 404 when registered path has been removed", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-reveal-"));
    const reg = await app.fetch(
      new Request("http://localhost/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: tmpProj }),
      }),
    );
    const { space } = (await reg.json()) as { space: { id: string } };
    fs.rmSync(tmpProj, { recursive: true, force: true });
    const resp = await app.fetch(
      new Request(`http://localhost/api/spaces/${space.id}/reveal`, {
        method: "POST",
      }),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string; path: string };
    expect(body.error).toBe("path_missing");
  });

  // Happy-path "spawns reveal command" not unit-tested: would launch a real
  // Finder/Explorer window during `bun test`. Verified manually via
  // chrome-devtools smoke (DRW-117 manual checklist).
});

describe("space middleware coexistence", () => {
  it("/api/spaces bypasses spaceMiddleware even when enableSpaceMiddleware=true", async () => {
    const { app: guarded } = makeApp({
      inMemory: true,
      enableSpaceMiddleware: true,
    });
    // No `?space=…` — would normally be 400 `space_required`. Spaces router
    // is mounted BEFORE the middleware, so it short-circuits.
    const resp = await guarded.fetch(
      new Request("http://localhost/api/spaces"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { spaces: unknown[] };
    expect(body.spaces).toEqual([]);
  });
});
