/**
 * localStorage-backed shortcut overrides.
 *
 * Handlers call `getActiveBinding(id)` at EVENT TIME, so a remap takes effect on
 * the next keypress with NO listener re-registration. The in-memory cache is the
 * source of truth; localStorage is just persistence.
 */

import type { Binding } from "./match";
import { getCommand } from "./registry";

const STORAGE_KEY = "shemma:shortcuts:config";

type OverrideMap = Record<string, Binding>;

let cache: OverrideMap | null = null;
const subscribers = new Set<() => void>();

function isBinding(v: unknown): v is Binding {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.code !== "string" || b.code.length === 0) return false;
  for (const k of ["mod", "alt", "shift"] as const) {
    if (b[k] !== undefined && typeof b[k] !== "boolean") return false;
  }
  return true;
}

/**
 * Read the override map from localStorage into the in-memory cache. Tolerant of
 * malformed payloads (camera-persist idiom): any parse / shape error yields an
 * empty map rather than throwing.
 */
export function loadConfig(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw) as unknown;
    const next: OverrideMap = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        // Only keep overrides for known commands with a valid binding shape.
        if (getCommand(id) && isBinding(value)) {
          next[id] = {
            mod: value.mod,
            alt: value.alt,
            shift: value.shift,
            code: value.code,
          };
        }
      }
    }
    cache = next;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

function ensureCache(): OverrideMap {
  if (cache === null) return loadConfig();
  return cache;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ensureCache()));
  } catch {
    // localStorage may throw (quota / disabled) — keep the in-memory cache.
  }
}

function notify(): void {
  for (const cb of subscribers) cb();
}

/**
 * Active binding for a command = override (if any) else the registry default.
 * Reads the cache FRESH on every call so handlers reflect remaps immediately.
 * Falls back to a never-matching sentinel only if `id` is unknown (defensive).
 */
export function getActiveBinding(id: string): Binding {
  const override = ensureCache()[id];
  if (override) return override;
  const cmd = getCommand(id);
  if (cmd) return cmd.defaultBinding;
  // Unknown id: return a binding that cannot match a real keypress.
  return { code: "__unknown__" };
}

/** Whether a command currently has a user override. */
export function hasOverride(id: string): boolean {
  return ensureCache()[id] !== undefined;
}

export function setOverride(id: string, binding: Binding): void {
  const c = ensureCache();
  c[id] = {
    mod: binding.mod,
    alt: binding.alt,
    shift: binding.shift,
    code: binding.code,
  };
  persist();
  notify();
}

export function clearOverride(id: string): void {
  const c = ensureCache();
  if (c[id] === undefined) return;
  delete c[id];
  persist();
  notify();
}

/** Clear every override (reset all shortcuts to defaults). */
export function clearAllOverrides(): void {
  const c = ensureCache();
  if (Object.keys(c).length === 0) return;
  cache = {};
  persist();
  notify();
}

/**
 * Subscribe to override changes (panel + any live display). Returns an
 * unsubscribe function.
 */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Test-only: reset the in-memory cache so loadConfig re-reads localStorage. */
export function __resetCacheForTests(): void {
  cache = null;
}
