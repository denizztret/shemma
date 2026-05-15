import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/index";

describe("autosave", () => {
  test("patch → canvas.json on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "didraw-as-"));
    const srv = await startServer({ port: 0, storageDir: dir });
    await fetch(`http://localhost:${srv.port}/api/patch?room=tst`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "add",
            target: "node",
            value: { id: "n1", kind: "rect", x: 5, y: 10 },
          },
        ],
        source: "user",
      }),
    });
    await new Promise((r) => setTimeout(r, 500));
    const path = join(dir, "tst.json");
    expect(existsSync(path)).toBe(true);
    const dump = JSON.parse(readFileSync(path, "utf8"));
    expect(dump.canvas.nodes[0].id).toBe("n1");
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
