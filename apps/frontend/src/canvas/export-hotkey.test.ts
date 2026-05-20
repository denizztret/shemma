import { describe, expect, test } from "bun:test";

function fakeKey(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault: () => void } {
  return {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    preventDefault: () => {},
  };
}

describe("makeExportHotkeyHandler — DRW-103", () => {
  test("fires on Cmd+Shift+E (Mac)", async () => {
    const { makeExportHotkeyHandler } = await import("./export-hotkey");
    const calls: string[][] = [];
    const handler = makeExportHotkeyHandler(
      () => ["shape:a", "shape:b"],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "E", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([["shape:a", "shape:b"]]);
  });

  test("fires on Ctrl+Shift+E (non-Mac)", async () => {
    const { makeExportHotkeyHandler } = await import("./export-hotkey");
    const calls: string[][] = [];
    const handler = makeExportHotkeyHandler(
      () => ["shape:a"],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent
    handler(fakeKey({ key: "e", ctrlKey: true, shiftKey: true }) as any);
    expect(calls).toHaveLength(1);
  });

  test("does NOT fire on Cmd+E (no shift)", async () => {
    const { makeExportHotkeyHandler } = await import("./export-hotkey");
    const calls: string[][] = [];
    const handler = makeExportHotkeyHandler(
      () => ["shape:a"],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent
    handler(fakeKey({ key: "E", metaKey: true, shiftKey: false }) as any);
    expect(calls).toHaveLength(0);
  });

  test("does NOT fire on Cmd+Shift+L (different key)", async () => {
    const { makeExportHotkeyHandler } = await import("./export-hotkey");
    const calls: string[][] = [];
    const handler = makeExportHotkeyHandler(
      () => ["shape:a"],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent
    handler(fakeKey({ key: "L", metaKey: true, shiftKey: true }) as any);
    expect(calls).toHaveLength(0);
  });

  test("passes empty array when no selection (caller decides UX)", async () => {
    const { makeExportHotkeyHandler } = await import("./export-hotkey");
    const calls: string[][] = [];
    const handler = makeExportHotkeyHandler(
      () => [],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent
    handler(fakeKey({ key: "E", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([[]]);
  });
});
