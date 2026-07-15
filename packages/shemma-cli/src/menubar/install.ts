// install/uninstall/status shim'а. Вся macOS-специфика фичи живёт здесь.
// `--plugin-dir <path>` = экспертный/тестовый режим: только файл-операции,
// без brew/defaults/open (поэтому subprocess-тесты гоняются на любой ОС).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { error as uiError, info as uiInfo, success as uiSuccess } from "../ui";
import { resolveCurrentVersion } from "../update";
import shimTemplate from "./shim.sh" with { type: "text" };

const DEFAULT_PLUGIN_DIR = join(homedir(), ".config", "swiftbar-plugins");
const SWIFTBAR_DEFAULTS_DOMAIN = "com.ameba.SwiftBar";
const SHIM_RE = /^shemma\..+\.sh$/;
const INTERVAL_RE = /^[0-9]+[smhd]$/;

export interface MenubarInstallOpts {
  interval: string;
  pluginDir?: string;
  yes: boolean;
}

export function parseMenubarFlags(argv: string[]): MenubarInstallOpts {
  const opts: MenubarInstallOpts = { interval: "5s", yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") opts.interval = argv[++i] ?? "";
    else if (argv[i] === "--plugin-dir") opts.pluginDir = argv[++i];
    else if (argv[i] === "--yes") opts.yes = true;
  }
  return opts;
}

function dieUsage(msg: string): never {
  uiError(msg, { code: "usage" });
  process.exit(1);
}

function shimFileName(interval: string): string {
  return `shemma.${interval}.sh`;
}

export function renderShim(version: string): string {
  return shimTemplate.replace("__VERSION__", version);
}

/** y/N-подтверждение через stdin (для brew-установки SwiftBar). */
async function confirmYes(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

function swiftBarInstalled(): boolean {
  return [
    "/Applications/SwiftBar.app",
    join(homedir(), "Applications", "SwiftBar.app"),
  ].some((p) => existsSync(p));
}

function readDefaultsPluginDir(): string | null {
  try {
    const out = execFileSync(
      "defaults",
      ["read", SWIFTBAR_DEFAULTS_DOMAIN, "PluginDirectory"],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // домен/ключ не заведён — SwiftBar ещё не настраивался
  }
}

function writeDefaultsPluginDir(dir: string): void {
  execFileSync(
    "defaults",
    ["write", SWIFTBAR_DEFAULTS_DOMAIN, "PluginDirectory", "-string", dir],
    { timeout: 3000 },
  );
}

function refreshSwiftBar(): void {
  // Запустить (если не запущен) и перечитать плагины; best-effort.
  try {
    execFileSync("open", ["-a", "SwiftBar"], { timeout: 5000 });
    execFileSync("open", ["swiftbar://refreshallplugins"], { timeout: 5000 });
  } catch {
    uiInfo("SwiftBar не откликнулся на refresh — обнови плагины вручную");
  }
}

/** Кладёт shim в dir, убирая варианты с другим интервалом. Идемпотентно. */
function writeShim(dir: string, interval: string): string {
  mkdirSync(dir, { recursive: true });
  const name = shimFileName(interval);
  for (const f of readdirSync(dir)) {
    if (SHIM_RE.test(f) && f !== name) rmSync(join(dir, f), { force: true });
  }
  const target = join(dir, name);
  writeFileSync(target, renderShim(resolveCurrentVersion()));
  chmodSync(target, 0o755);
  return target;
}

function findInstalledShim(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).find((f) => SHIM_RE.test(f));
  return found ?? null;
}

export async function cmdMenubarInstall(
  opts: MenubarInstallOpts,
): Promise<void> {
  if (!INTERVAL_RE.test(opts.interval)) {
    dieUsage(
      `invalid --interval "${opts.interval}" (ожидается вида 5s | 30s | 1m)`,
    );
  }
  // Экспертный/тестовый путь: только файлы.
  if (opts.pluginDir !== undefined) {
    const target = writeShim(opts.pluginDir, opts.interval);
    uiSuccess(`shim installed: ${target}`);
    return;
  }
  if (process.platform !== "darwin") {
    uiError("menubar install поддерживается только на macOS", {
      code: "not-darwin",
    });
    process.exit(1);
  }
  if (!swiftBarInstalled()) {
    const doInstall =
      opts.yes ||
      (await confirmYes(
        "SwiftBar не установлен. brew install --cask swiftbar?",
      ));
    if (!doInstall) {
      uiError("SwiftBar не установлен", {
        code: "swiftbar-missing",
        hint: "brew install --cask swiftbar, затем повтори shemma menubar install",
      });
      process.exit(1);
    }
    execFileSync("brew", ["install", "--cask", "swiftbar"], {
      stdio: "inherit",
    });
  }
  let dir = readDefaultsPluginDir();
  if (dir === null) {
    dir = DEFAULT_PLUGIN_DIR;
    mkdirSync(dir, { recursive: true });
    writeDefaultsPluginDir(dir);
    uiInfo(`SwiftBar plugin dir → ${dir} (defaults write)`);
  }
  const target = writeShim(dir, opts.interval);
  refreshSwiftBar();
  uiSuccess(`shim installed: ${target}`);
}

export async function cmdMenubarUninstall(
  opts: MenubarInstallOpts,
): Promise<void> {
  const dir = opts.pluginDir ?? readDefaultsPluginDir() ?? DEFAULT_PLUGIN_DIR;
  const found = findInstalledShim(dir);
  if (found === null) {
    uiInfo("shim not installed — nothing to remove");
    return;
  }
  rmSync(join(dir, found), { force: true });
  if (opts.pluginDir === undefined && process.platform === "darwin") {
    try {
      execFileSync("open", ["swiftbar://refreshallplugins"], { timeout: 5000 });
    } catch {
      // best-effort
    }
  }
  uiSuccess(`shim removed: ${join(dir, found)}`);
}

export async function cmdMenubarStatus(
  opts: MenubarInstallOpts,
): Promise<void> {
  const dir = opts.pluginDir ?? readDefaultsPluginDir() ?? DEFAULT_PLUGIN_DIR;
  const found = findInstalledShim(dir);
  if (found === null) {
    uiInfo(`not installed (plugin dir: ${dir})`);
    return;
  }
  const interval = found.replace(/^shemma\./, "").replace(/\.sh$/, "");
  uiInfo(`installed: ${join(dir, found)} (interval ${interval})`);
}
