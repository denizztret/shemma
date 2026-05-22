import { describe, expect, test } from "bun:test";
import { gitDescribe, resolveVersion } from "../version";

describe("DRW-119: resolveVersion fallback chain", () => {
  test("envVersion wins over everything else", () => {
    const v = resolveVersion({
      envVersion: "9.9.9",
      describe: () => "0.21.7-5-gabc1234",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("9.9.9");
  });

  test("clean tag from git describe → returned as-is", () => {
    const v = resolveVersion({
      envVersion: "",
      describe: () => "0.21.7",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7");
  });

  test("ahead-of-tag git describe → returned with distance + sha", () => {
    const v = resolveVersion({
      envVersion: "",
      describe: () => "0.21.7-5-gabc1234",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7-5-gabc1234");
  });

  test("dirty git describe → suffix preserved", () => {
    const v = resolveVersion({
      envVersion: "",
      describe: () => "0.21.7-5-gabc1234-dirty",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7-5-gabc1234-dirty");
  });

  test("empty envVersion + describe null → pkg.version + '-dev'", () => {
    const v = resolveVersion({
      envVersion: "",
      describe: () => null,
      pkgVersion: "1.2.3",
    });
    expect(v).toBe("1.2.3-dev");
  });

  test("empty envVersion + describe null + no pkgVersion → real pkg.version + '-dev'", () => {
    const v = resolveVersion({ envVersion: "", describe: () => null });
    expect(v).toMatch(/^\d+\.\d+\.\d+-dev$/);
  });
});

describe("DRW-119: gitDescribe integration (real repo)", () => {
  test("returns a non-empty string on this repo (git available + tags present)", () => {
    const out = gitDescribe();
    if (out !== null) {
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      expect(out).toMatch(/^[0-9a-f]{7,}(-dirty)?$|^\d+\.\d+\.\d+(-\d+-g[0-9a-f]+)?(-dirty)?$/);
    }
  });

  test("returns null for non-git cwd", () => {
    const out = gitDescribe("/tmp");
    if (out !== null) {
      expect(typeof out).toBe("string");
    } else {
      expect(out).toBeNull();
    }
  });
});
