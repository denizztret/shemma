import { describe, expect, test } from "bun:test";
import type { StopAllResult } from "../src/daemon";
import {
  boardUrl,
  formatStopAllSummary,
  spaceUrl,
} from "../src/menubar/actions";

describe("URL-билдеры", () => {
  test("boardUrl", () => {
    expect(boardUrl(8787)).toBe("http://localhost:8787/");
  });
  test("spaceUrl экранирует id", () => {
    expect(spaceUrl(8787, "di-draw")).toBe(
      "http://localhost:8787/?space=di-draw",
    );
    expect(spaceUrl(8787, "a b")).toBe("http://localhost:8787/?space=a%20b");
  });
});

describe("formatStopAllSummary", () => {
  test("остановленные считаются", () => {
    const results: StopAllResult[] = [
      { ok: true, profile: "release", stopped: 61713 },
      { ok: true, profile: "dev", already: true },
      { ok: true, profile: "debug", already: true },
    ];
    expect(formatStopAllSummary(results)).toBe("Остановлено демонов: 1");
  });
  test("нечего останавливать", () => {
    const results: StopAllResult[] = [
      { ok: true, profile: "release", already: true },
      { ok: true, profile: "dev", already: true },
      { ok: true, profile: "debug", already: true },
    ];
    expect(formatStopAllSummary(results)).toBe("Демоны уже остановлены");
  });
});
