import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetCacheForTests,
  clearAllOverrides,
  clearOverride,
  getActiveBinding,
  hasOverride,
  loadConfig,
  setOverride,
  subscribe,
} from "./config";
import type { Binding } from "./match";
import { getCommand } from "./registry";

// Minimal localStorage mock backed by a plain object.
function installMockStorage(): { store: Record<string, string> } {
  const store: Record<string, string> = {};
  const mock = {
    getItem(k: string): string | null {
      return k in store ? store[k]! : null;
    },
    setItem(k: string, v: string): void {
      store[k] = v;
    },
    removeItem(k: string): void {
      delete store[k];
    },
    clear(): void {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test-only global stub
  (globalThis as any).localStorage = mock;
  return { store };
}

let storage: { store: Record<string, string> };

beforeEach(() => {
  storage = installMockStorage();
  __resetCacheForTests();
});

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: clean up stub
  (globalThis as any).localStorage = undefined;
  __resetCacheForTests();
});

const NEW_BINDING: Binding = { mod: true, alt: true, code: "KeyJ" };

describe("getActiveBinding fallback", () => {
  test("returns the registry default when no override exists", () => {
    expect(getActiveBinding("prompt")).toEqual(
      getCommand("prompt")!.defaultBinding,
    );
  });

  test("returns a never-matching sentinel for unknown id", () => {
    expect(getActiveBinding("does-not-exist").code).toBe("__unknown__");
  });
});

describe("override round-trip", () => {
  test("set → get reflects override and persists to localStorage", () => {
    setOverride("copy-link", NEW_BINDING);
    expect(getActiveBinding("copy-link")).toEqual(NEW_BINDING);
    expect(hasOverride("copy-link")).toBe(true);
    // Persisted JSON contains the override.
    const raw = storage.store["shemma:shortcuts:config"]!;
    expect(JSON.parse(raw)["copy-link"]).toEqual({
      mod: true,
      alt: true,
      shift: undefined,
      code: "KeyJ",
    });
  });

  test("clear removes override and falls back to default", () => {
    setOverride("copy-link", NEW_BINDING);
    clearOverride("copy-link");
    expect(hasOverride("copy-link")).toBe(false);
    expect(getActiveBinding("copy-link")).toEqual(
      getCommand("copy-link")!.defaultBinding,
    );
  });

  test("loadConfig reads persisted overrides after a fresh cache", () => {
    setOverride("export-miro", NEW_BINDING);
    // Simulate a new page load: drop cache, re-read from storage.
    __resetCacheForTests();
    const cfg = loadConfig();
    expect(cfg["export-miro"]).toEqual({
      mod: true,
      alt: true,
      shift: undefined,
      code: "KeyJ",
    });
    expect(getActiveBinding("export-miro")).toEqual(NEW_BINDING);
  });

  test("clearAllOverrides resets every command to default", () => {
    setOverride("prompt", NEW_BINDING);
    setOverride("export-miro", NEW_BINDING);
    clearAllOverrides();
    expect(hasOverride("prompt")).toBe(false);
    expect(hasOverride("export-miro")).toBe(false);
    expect(getActiveBinding("prompt")).toEqual(
      getCommand("prompt")!.defaultBinding,
    );
  });
});

describe("malformed persistence", () => {
  test("ignores unknown command ids and bad shapes", () => {
    storage.store["shemma:shortcuts:config"] = JSON.stringify({
      "unknown-cmd": { mod: true, code: "KeyZ" },
      prompt: { code: 123 }, // bad shape
      "copy-link": { mod: true, code: "KeyQ" }, // valid
    });
    __resetCacheForTests();
    loadConfig();
    expect(getActiveBinding("unknown-cmd").code).toBe("__unknown__");
    // prompt had a bad-shape override → falls back to default.
    expect(getActiveBinding("prompt")).toEqual(
      getCommand("prompt")!.defaultBinding,
    );
    // copy-link valid override applied.
    expect(getActiveBinding("copy-link")).toEqual({ mod: true, code: "KeyQ" });
  });

  test("invalid JSON yields empty config", () => {
    storage.store["shemma:shortcuts:config"] = "{not json";
    __resetCacheForTests();
    expect(loadConfig()).toEqual({});
  });
});

describe("subscribe", () => {
  test("notifies on set / clear and unsubscribes cleanly", () => {
    let count = 0;
    const unsub = subscribe(() => {
      count++;
    });
    setOverride("prompt", NEW_BINDING);
    clearOverride("prompt");
    expect(count).toBe(2);
    unsub();
    setOverride("prompt", NEW_BINDING);
    expect(count).toBe(2);
  });
});
