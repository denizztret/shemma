// Subprocess-паттерн из cli-spaces.test.ts: Bun.spawn + XDG_CONFIG_HOME в tmpdir.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: tmpXdg,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-config-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("config menubar.label", () => {
  test("get до set — [unset]", async () => {
    const r = await runCli(["config", "get", "menubar.label"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[unset]");
  });

  test("set → get возвращает значение", async () => {
    const set = await runCli(["config", "set", "menubar.label", "shemma"]);
    expect(set.status).toBe(0);
    const get = await runCli(["config", "get", "menubar.label"]);
    expect(get.status).toBe(0);
    expect(get.stdout).toContain('"shemma"');
    // Значение реально в config.json
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpXdg, "shemma", "config.json"), "utf8"),
    );
    expect(raw.menubar.label).toBe("shemma");
  });

  test("unset удаляет значение", async () => {
    await runCli(["config", "set", "menubar.label", "x"]);
    const unset = await runCli(["config", "unset", "menubar.label"]);
    expect(unset.status).toBe(0);
    const get = await runCli(["config", "get", "menubar.label"]);
    expect(get.stdout).toContain("[unset]");
  });
});
