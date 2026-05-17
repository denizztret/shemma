import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Profile } from "./profile";

/**
 * Profile-specific subdirectory под которым daemon хранит rooms.
 * Дублирует convention из apps/backend/src/config.ts (storageSubdir),
 * чтобы parallel dev+release daemons на одном --storage пути не конфликтовали:
 *
 *   <user-path>/canvas/       ← release / debug
 *   <user-path>/canvas-dev/   ← dev
 */
const STORAGE_SUBDIR: Record<Profile, string> = {
  dev: "canvas-dev",
  release: "canvas",
  debug: "canvas",
};

export type StorageArgResult = {
  /** Resolved absolute user-path (без profile-subdir-а). undefined если флаг не задан. */
  storage?: string;
  /** Errors discovered during argv parsing (e.g. flag без value). */
  errors: string[];
  /** Stripped argv (без `--storage <value>`) для дальнейшего парсинга. */
  rest: string[];
};

/**
 * Парсит `--storage <path>` из произвольного argv-куска.
 * Возвращает резолвленный (относительно cwd) абсолютный path или undefined.
 * Не делает I/O — caller отдельно вызывает ensureStorageDir().
 */
export function parseStorageArg(argv: string[], cwd: string): StorageArgResult {
  const errors: string[] = [];
  const rest: string[] = [];
  let storage: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--storage") {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        errors.push("--storage requires a path value");
        // Don't advance i — let next iteration handle the next token normally.
        continue;
      }
      storage = isAbsolute(val) ? val : resolve(cwd, val);
      i++; // consume value
      continue;
    }
    rest.push(argv[i]);
  }
  return { storage, errors, rest };
}

/**
 * Возвращает финальный storage dir для конкретного profile под user-provided base path:
 *   resolveStorageDirForProfile("/foo", "dev")     === "/foo/canvas-dev"
 *   resolveStorageDirForProfile("/foo", "release") === "/foo/canvas"
 *   resolveStorageDirForProfile("/foo", "debug")   === "/foo/canvas"
 */
export function resolveStorageDirForProfile(
  basePath: string,
  profile: Profile,
): string {
  return join(basePath, STORAGE_SUBDIR[profile]);
}

/**
 * Создаёт directory (и parents) для финального storage path.
 * Возвращает error message или null при успехе.
 * Не throws — caller сам формирует JSON error и exit code.
 */
export function ensureStorageDir(path: string): string | null {
  try {
    mkdirSync(path, { recursive: true });
    return null;
  } catch (e) {
    return `cannot create storage dir "${path}": ${(e as Error).message}`;
  }
}
