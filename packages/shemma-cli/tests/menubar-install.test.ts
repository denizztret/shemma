import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;
let pluginDir: string;

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
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-xdg-"));
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-plugins-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

describe("menubar install --plugin-dir", () => {
  test("ставит исполняемый shim shemma.5s.sh", async () => {
    const r = await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    expect(r.status).toBe(0);
    const shim = path.join(pluginDir, "shemma.5s.sh");
    expect(fs.existsSync(shim)).toBe(true);
    const mode = fs.statSync(shim).mode;
    expect(mode & 0o111).toBeGreaterThan(0); // исполняемый
    const body = fs.readFileSync(shim, "utf8");
    expect(body).toContain("<bitbar.title>shemma</bitbar.title>");
    expect(body).toContain('menubar "${1:-render}"');
    expect(body).not.toContain("__VERSION__"); // placeholder заменён
  });

  test("--interval 10s → shemma.10s.sh; старый shim удаляется", async () => {
    await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    const r = await runCli([
      "menubar",
      "install",
      "--plugin-dir",
      pluginDir,
      "--interval",
      "10s",
    ]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(pluginDir, "shemma.10s.sh"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "shemma.5s.sh"))).toBe(false);
  });

  test("невалидный interval → exit 1", async () => {
    const r = await runCli([
      "menubar",
      "install",
      "--plugin-dir",
      pluginDir,
      "--interval",
      "banana",
    ]);
    expect(r.status).toBe(1);
  });
});

describe("menubar status --plugin-dir", () => {
  test("не установлен", async () => {
    const r = await runCli(["menubar", "status", "--plugin-dir", pluginDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not installed");
  });

  test("установлен — путь и интервал", async () => {
    await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    const r = await runCli(["menubar", "status", "--plugin-dir", pluginDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shemma.5s.sh");
    expect(r.stdout).toContain("5s");
  });
});

describe("menubar uninstall --plugin-dir", () => {
  test("удаляет shim; повторный uninstall не падает", async () => {
    await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    const r1 = await runCli([
      "menubar",
      "uninstall",
      "--plugin-dir",
      pluginDir,
    ]);
    expect(r1.status).toBe(0);
    expect(fs.existsSync(path.join(pluginDir, "shemma.5s.sh"))).toBe(false);
    const r2 = await runCli([
      "menubar",
      "uninstall",
      "--plugin-dir",
      pluginDir,
    ]);
    expect(r2.status).toBe(0);
  });
});
