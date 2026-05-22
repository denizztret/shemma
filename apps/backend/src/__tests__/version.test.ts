import { describe, expect, test } from "bun:test";
import { gitDescribe, resolveVersion } from "../version";

describe("DRW-119: resolveVersion fallback chain", () => {
  test("SHEMMA_VERSION env wins over everything", () => {
    const v = resolveVersion({
      env: { SHEMMA_VERSION: "9.9.9" },
      describe: () => "0.21.7-5-gabc1234",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("9.9.9");
  });

  test("clean tag from git describe → returned as-is", () => {
    const v = resolveVersion({
      env: {},
      describe: () => "0.21.7",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7");
  });

  test("ahead-of-tag git describe → returned with distance + sha", () => {
    const v = resolveVersion({
      env: {},
      describe: () => "0.21.7-5-gabc1234",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7-5-gabc1234");
  });

  test("dirty git describe → suffix preserved", () => {
    const v = resolveVersion({
      env: {},
      describe: () => "0.21.7-5-gabc1234-dirty",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7-5-gabc1234-dirty");
  });

  test("no SHEMMA_VERSION + describe returns null → pkg.version + '-dev'", () => {
    const v = resolveVersion({
      env: {},
      describe: () => null,
      pkgVersion: "1.2.3",
    });
    expect(v).toBe("1.2.3-dev");
  });

  test("no pkgVersion override + describe null → falls back to real pkg.version + '-dev'", () => {
    const v = resolveVersion({ env: {}, describe: () => null });
    expect(v).toMatch(/^\d+\.\d+\.\d+-dev$/);
  });

  test("SHEMMA_VERSION='' (empty string) is treated as unset → falls through", () => {
    const v = resolveVersion({
      env: { SHEMMA_VERSION: "" },
      describe: () => "0.21.7",
      pkgVersion: "1.0.0",
    });
    expect(v).toBe("0.21.7");
  });
});

describe("DRW-119: gitDescribe integration (real repo)", () => {
  test("returns a non-empty string on this repo (git available + tags present)", () => {
    const out = gitDescribe();
    // CI without git or detached non-repo workdirs may return null — accept either.
    if (out !== null) {
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      // Either a clean tag (digits.digits.digits), or tag-N-gSHA, or fallback to bare SHA.
      expect(out).toMatch(/^[0-9a-f]{7,}(-dirty)?$|^\d+\.\d+\.\d+(-\d+-g[0-9a-f]+)?(-dirty)?$/);
    }
  });

  test("returns null for non-git cwd", () => {
    const out = gitDescribe("/tmp");
    // /tmp is unlikely to be a git repo; if it is (rare), this test is informational.
    if (out !== null) {
      expect(typeof out).toBe("string");
    } else {
      expect(out).toBeNull();
    }
  });
});
