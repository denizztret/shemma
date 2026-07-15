// Действия пунктов меню (`shemma menubar do <action> [arg]`). Тонкие обёртки
// над существующими daemon/browser/update функциями. Ошибки — громко:
// error-file (render покажет красным) + macOS-notification, никаких тихих
// падений. stdout действий SwiftBar игнорирует.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  configFilePath,
  readConfig,
  writeConfig,
} from "@shemma/backend/src/config";
import { openBrowser } from "../browser";
import { type StopAllResult, ensure, stop, stopAll } from "../daemon";
import { logFile, portFor } from "../profile";
import { cmdUpdate } from "../update";
import { clearMenubarError, writeMenubarError } from "./error-file";

/** Menubar управляет release-профилем (спека: dev — read-only строка). */
const PROFILE = "release" as const;

export function boardUrl(port: number): string {
  return `http://localhost:${port}/`;
}

export function spaceUrl(port: number, spaceId: string): string {
  return `http://localhost:${port}/?space=${encodeURIComponent(spaceId)}`;
}

export function formatStopAllSummary(results: StopAllResult[]): string {
  const stopped = results.filter((r) => r.stopped !== undefined).length;
  return stopped > 0
    ? `Остановлено демонов: ${stopped}`
    : "Демоны уже остановлены";
}

/** macOS-уведомление, best-effort (не darwin / нет osascript → no-op). */
export function notify(message: string): void {
  if (process.platform !== "darwin") return;
  const esc = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFile(
      "osascript",
      ["-e", `display notification "${esc}" with title "shemma"`],
      () => {},
    );
  } catch {
    // best-effort
  }
}

export async function runAction(action: string, arg?: string): Promise<void> {
  switch (action) {
    case "start":
      return doStart();
    case "stop":
      await stop(PROFILE);
      clearMenubarError();
      return;
    case "restart":
      await stop(PROFILE).catch(() => {});
      return doStart();
    case "stop-all": {
      const results = await stopAll();
      clearMenubarError();
      notify(formatStopAllSummary(results));
      return;
    }
    case "open-board":
      await doStart();
      openBrowser(boardUrl(portFor(PROFILE)));
      return;
    case "open-space": {
      if (!arg) {
        notify("open-space: не передан id space");
        process.exit(1);
      }
      openBrowser(spaceUrl(portFor(PROFILE), arg));
      return;
    }
    case "open-log": {
      const p = logFile(PROFILE);
      if (!existsSync(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "");
      }
      execFile("open", ["-t", p], () => {});
      return;
    }
    case "edit-config": {
      try {
        if (readConfig() === null) writeConfig({});
      } catch {
        // битый JSON — всё равно откроем файл, юзер поправит руками
      }
      execFile("open", ["-t", configFilePath()], () => {});
      return;
    }
    case "update":
      // Запускается из меню с terminal=true — прогресс виден в Terminal.
      return cmdUpdate([]);
    default:
      notify(`Неизвестное действие меню: ${action}`);
      process.exit(1);
  }
}

async function doStart(): Promise<void> {
  try {
    await ensure(PROFILE);
    clearMenubarError();
  } catch (e) {
    const msg = `Старт демона упал: ${String(e)}`;
    writeMenubarError(msg);
    notify(msg);
    throw e;
  }
}
