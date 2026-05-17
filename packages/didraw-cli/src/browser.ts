import { spawn } from "node:child_process";

/**
 * Launches the default browser for `url` in a detached subprocess.
 *
 * Per-platform launcher:
 *   - darwin → `open <url>`
 *   - win32  → `start "" <url>` (empty title is required by cmd's `start`)
 *   - linux/* → `xdg-open <url>`
 *
 * Detached + `unref()` чтобы CLI process не блокировался браузером и мог exit
 * сразу после spawn.
 *
 * Best-effort: ошибки не пробрасываем — если spawn fail'ит, user сам откроет
 * URL по printed-line. Это не critical path, daemon уже запущен.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    // Swallow spawn errors emitted asynchronously (e.g. cmd not found on
    // headless Linux). Без listener'а Node бросает unhandled 'error'.
    child.on("error", () => {});
  } catch {
    // Synchronous spawn() failures (rare) — ignore.
  }
}
