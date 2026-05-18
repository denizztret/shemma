import { describe, expect, it, spyOn, afterEach } from "bun:test";

describe("chdirToProjectDir helper", () => {
  let chdirSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  const captured: { chdirArg?: string; stderrChunks: string[] } = {
    stderrChunks: [],
  };

  function setup() {
    captured.chdirArg = undefined;
    captured.stderrChunks = [];
    chdirSpy = spyOn(process, "chdir").mockImplementation((p) => {
      captured.chdirArg = String(p);
    });
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      captured.stderrChunks.push(String(chunk));
      return true;
    });
  }

  afterEach(() => {
    chdirSpy?.mockRestore();
    stderrSpy?.mockRestore();
  });

  it("calls process.chdir with given projectDir on success", async () => {
    setup();
    const { chdirToProjectDir } = await import("./index");
    chdirToProjectDir("/tmp/proj");
    expect(captured.chdirArg).toBe("/tmp/proj");
    expect(captured.stderrChunks.join("")).toBe("");
  });

  it("emits stderr warning and does not throw when process.chdir throws", async () => {
    setup();
    chdirSpy.mockRestore();
    chdirSpy = spyOn(process, "chdir").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const { chdirToProjectDir } = await import("./index");

    // Must not throw.
    expect(() => chdirToProjectDir("/nonexistent/path")).not.toThrow();

    expect(captured.stderrChunks.join("")).toMatch(/SHEMMA_CWD.*not accessible/);
    expect(captured.stderrChunks.join("")).toMatch(/ENOENT/);
    expect(captured.stderrChunks.join("")).toMatch(/continuing with inherited cwd/);
  });
});
