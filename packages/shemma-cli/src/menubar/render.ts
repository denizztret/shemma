// Чистый рендер SwiftBar-меню: MenubarData → текст. Никакого IO — все данные
// собирает caller (menubar/index.ts), поэтому модуль полностью unit-тестируем.
// Формат SwiftBar: https://github.com/swiftbar/SwiftBar#plugin-api
import type { CheckResult } from "../doctor";
import type { ProfileStatus } from "../ps";
import {
  ICON_ERROR,
  ICON_MENU_BOARD,
  ICON_MENU_CONFIG,
  ICON_MENU_LOG,
  ICON_MENU_PLAY,
  ICON_MENU_RESTART,
  ICON_MENU_SPACES,
  ICON_MENU_STOP,
  ICON_MENU_STOP_ALL,
  ICON_MENU_UPDATE,
  ICON_RUNNING,
  ICON_STOPPED,
} from "./icons";

export interface MenubarSpace {
  id: string;
  label?: string;
}

export interface MenubarUpdate {
  available: boolean;
  latest: string | null;
}

export interface MenubarData {
  release: ProfileStatus;
  dev: ProfileStatus;
  version: string;
  lastError: string | null;
  spaces: MenubarSpace[];
  doctor: CheckResult[];
  update: MenubarUpdate;
  /** Подпись рядом с иконкой (config menubar.label); пусто → только иконка. */
  label: string;
  /** Путь, который SwiftBar вызовет в action-строках (shim или бинарь). */
  self: string;
  /** [] — вызов через shim; ["menubar"] — прямой вызов бинаря. */
  paramPrefix: string[];
}

export type MenubarState = "running" | "stopped" | "error";

export function menubarState(d: MenubarData): MenubarState {
  if (d.release.running && d.release.healthy) return "running";
  if (d.release.running && !d.release.healthy) return "error";
  if (d.lastError !== null) return "error";
  return "stopped";
}

/** Собирает `bash=... paramN=...` для пункта меню. */
function act(d: MenubarData, parts: string[], extra: string): string {
  const params = [...d.paramPrefix, ...parts]
    .map((p, i) => `param${i + 1}=${p}`)
    .join(" ");
  return `bash="${d.self}" ${params} ${extra}`;
}

const RUN = "terminal=false refresh=true";
const OPEN = "terminal=false refresh=false";

export function renderMenu(d: MenubarData): string {
  const out: string[] = [];
  const state = menubarState(d);
  const icon =
    state === "running"
      ? ICON_RUNNING
      : state === "error"
        ? ICON_ERROR
        : ICON_STOPPED;
  out.push(`${d.label ? `${d.label} ` : ""}| image=${icon}`);
  out.push("---");

  // Статус-блок
  if (state === "running") {
    out.push(
      `Работает · :${d.release.port} · pid ${d.release.pid ?? "?"} · v${d.version} | color=gray`,
    );
  } else if (state === "error") {
    const msg = d.release.running
      ? `Демон не отвечает на :${d.release.port}`
      : (d.lastError ?? "Ошибка");
    out.push(`${msg} | color=red`);
  } else {
    out.push("Остановлен | color=gray");
  }
  if (d.dev.running) {
    out.push(`dev · :${d.dev.port} · работает | color=gray`);
  }
  if (d.update.available && d.update.latest !== null) {
    out.push(
      `⬆ Доступно обновление ${d.update.latest} | templateImage=${ICON_MENU_UPDATE} ${act(d, ["do", "update"], "terminal=true refresh=true")}`,
    );
  }
  out.push("---");

  // Управление демоном
  if (state === "running") {
    out.push(
      `Остановить | templateImage=${ICON_MENU_STOP} ${act(d, ["do", "stop"], RUN)}`,
    );
    out.push(
      `Перезапустить | templateImage=${ICON_MENU_RESTART} ${act(d, ["do", "restart"], RUN)}`,
    );
  } else {
    out.push(
      `Запустить | templateImage=${ICON_MENU_PLAY} ${act(d, ["do", "start"], RUN)}`,
    );
  }
  out.push(
    `Остановить всё | templateImage=${ICON_MENU_STOP_ALL} ${act(d, ["do", "stop-all"], RUN)}`,
  );
  out.push("---");

  // Открытие — активно только при работающем демоне (иначе пустая страница):
  // неактивный пункт = серый текст без action-параметров, Spaces без сабменю.
  if (state === "running") {
    out.push(
      `Открыть доску | templateImage=${ICON_MENU_BOARD} ${act(d, ["do", "open-board"], OPEN)}`,
    );
    if (d.spaces.length > 0) {
      out.push(`Spaces | templateImage=${ICON_MENU_SPACES}`);
      for (const s of d.spaces) {
        out.push(
          `-- ${s.label ?? s.id} | ${act(d, ["do", "open-space", s.id], OPEN)}`,
        );
      }
    }
  } else {
    out.push(`Открыть доску | templateImage=${ICON_MENU_BOARD} color=gray`);
    if (d.spaces.length > 0) {
      out.push(`Spaces | templateImage=${ICON_MENU_SPACES} color=gray`);
    }
  }
  out.push("---");

  // Диагностика
  const bad = d.doctor.filter((c) => c.status !== "ok");
  if (bad.length === 0) {
    out.push("Doctor: ✔ ok | color=gray");
  } else {
    const fails = bad.filter((c) => c.status === "fail").length;
    const warns = bad.filter((c) => c.status === "warn").length;
    const counts = [
      ...(fails > 0 ? [`${fails} fail`] : []),
      ...(warns > 0 ? [`${warns} warn`] : []),
    ].join(", ");
    out.push(`Doctor: ⚠ ${counts}`);
    for (const c of bad) {
      out.push(`-- [${c.status}] ${c.check}: ${c.detail}`);
    }
  }
  out.push(
    `Открыть лог демона | templateImage=${ICON_MENU_LOG} ${act(d, ["do", "open-log"], OPEN)}`,
  );
  out.push("---");

  // Хвост
  out.push(
    `Изменить конфиг… | templateImage=${ICON_MENU_CONFIG} ${act(d, ["do", "edit-config"], OPEN)}`,
  );
  out.push(`Helper v${d.version} | color=gray`);
  return out.join("\n");
}

/** Аварийное меню: render никогда не падает — исключение превращается в это. */
export function renderErrorMenu(message: string): string {
  return [
    `| image=${ICON_ERROR}`,
    "---",
    "Ошибка рендера меню | color=red",
    `${message} | color=gray`,
  ].join("\n");
}
