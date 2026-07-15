// Маркер последнего упавшего старта (паттерн ERRORFILE из madstudio-helper):
// упавший `do start` пишет сообщение, render показывает его красным,
// успешный start/stop чистит. Конвенция state-файлов CLI: ~/.claude/.shemma-*.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function menubarErrorPath(): string {
  return join(homedir(), ".claude", ".shemma-menubar-error");
}

export function readMenubarError(path = menubarErrorPath()): string | null {
  try {
    if (!existsSync(path)) return null;
    const msg = readFileSync(path, "utf8").trim();
    return msg.length > 0 ? msg : null;
  } catch {
    return null;
  }
}

export function writeMenubarError(
  msg: string,
  path = menubarErrorPath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, msg);
  } catch {
    // best-effort: сломанный маркер не должен ломать action
  }
}

export function clearMenubarError(path = menubarErrorPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // идемпотентно
  }
}
