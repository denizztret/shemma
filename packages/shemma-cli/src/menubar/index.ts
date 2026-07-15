// Диспетчер `shemma menubar <sub>` + сборка данных для рендера.
// render — presentation-интерфейс для SwiftBar (НЕ machine API: формат вывода
// не покрывается гарантиями стабильности CLI, см. README).
import { readConfig } from "@shemma/backend/src/config";
import { listSpaces } from "@shemma/spaces";
import { runDoctorChecks } from "../doctor";
import { collectProfileStatuses } from "../ps";
import { error as uiError } from "../ui";
import { checkUpdateAvailable, resolveCurrentVersion } from "../update";
import { runAction } from "./actions";
import { readMenubarError } from "./error-file";
import {
  cmdMenubarInstall,
  cmdMenubarStatus,
  cmdMenubarUninstall,
  parseMenubarFlags,
} from "./install";
import {
  type MenubarData,
  type MenubarSpace,
  renderErrorMenu,
  renderMenu,
} from "./render";
import { getUpdateBadge, updateCachePath, withTimeout } from "./update-cache";

const UPDATE_TTL_MS = 6 * 3600_000;
const UPDATE_CHECK_TIMEOUT_MS = 2000;
/** Только релевантные меню чеки: без bun/shemma-version (шум) и manifest (сеть). */
const MENU_DOCTOR_RE =
  /^(daemon-status|port-owner|storage-writable|config-readable)/;

export async function cmdMenubar(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "render";
  const rest = argv.slice(1);
  if (sub === "render") return cmdRender();
  if (sub === "do") {
    const action = rest[0];
    if (!action) {
      uiError("usage: shemma menubar do <action> [arg]", { code: "usage" });
      process.exit(1);
    }
    return runAction(action, rest[1]);
  }
  if (sub === "install") return cmdMenubarInstall(parseMenubarFlags(rest));
  if (sub === "uninstall") return cmdMenubarUninstall(parseMenubarFlags(rest));
  if (sub === "status") return cmdMenubarStatus(parseMenubarFlags(rest));
  uiError(`unknown menubar subcommand: ${sub}`, { code: "usage" });
  process.exit(1);
}

/** SwiftBar зовёт action-строки: через shim (SWIFTBAR_PLUGIN_PATH) или бинарь. */
function resolveSelf(): { self: string; paramPrefix: string[] } {
  const plugin = process.env.SWIFTBAR_PLUGIN_PATH;
  if (plugin) return { self: plugin, paramPrefix: [] };
  return { self: process.execPath, paramPrefix: ["menubar"] };
}

async function cmdRender(): Promise<void> {
  try {
    const [statuses, doctorAll, update] = await Promise.all([
      collectProfileStatuses(),
      runDoctorChecks(["release"], { network: false }),
      getUpdateBadge({
        cachePath: updateCachePath(),
        ttlMs: UPDATE_TTL_MS,
        now: Date.now(),
        check: async () => {
          const b = await withTimeout(
            checkUpdateAvailable(),
            UPDATE_CHECK_TIMEOUT_MS,
          );
          return { available: b.available, latest: b.latest };
        },
      }),
    ]);
    const release = statuses.find((s) => s.profile === "release");
    const dev = statuses.find((s) => s.profile === "dev");
    if (!release || !dev) throw new Error("profile status missing");
    let spaces: MenubarSpace[] = [];
    try {
      spaces = listSpaces().map((s) => ({ id: s.id, label: s.label }));
    } catch {
      // реестр spaces битый/недоступен — меню живёт без сабменю
    }
    let label = "";
    try {
      label = readConfig()?.menubar?.label ?? "";
    } catch {
      // битый config.json — не роняем рендер
    }
    const data: MenubarData = {
      release,
      dev,
      version: resolveCurrentVersion(),
      lastError: readMenubarError(),
      spaces,
      doctor: doctorAll.filter((c) => MENU_DOCTOR_RE.test(c.check)),
      update,
      label,
      ...resolveSelf(),
    };
    console.log(renderMenu(data));
  } catch (e) {
    // render никогда не падает — SwiftBar получает валидное error-меню.
    console.log(renderErrorMenu(String(e)));
  }
}
