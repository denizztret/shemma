import { describe, expect, test } from "bun:test";
import {
  type Binding,
  type KeyboardEventLike,
  bindingFromEvent,
  bindingsEqual,
  codeToKey,
  formatBinding,
  matchShortcut,
} from "./match";
import { SHORTCUT_REGISTRY, getCommand } from "./registry";

/** Build a KeyboardEvent-like object with sensible defaults. */
function ev(p: Partial<KeyboardEventLike>): KeyboardEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
    key: "",
    ...p,
  };
}

// Historical modifier combos for each of the 8 commands. metaKey-based row is
// the macOS path; the registry default must MATCH both meta and ctrl variants.
const HISTORICAL: Record<
  string,
  { meta: KeyboardEventLike; ctrl: KeyboardEventLike }
> = {
  prompt: {
    meta: ev({ metaKey: true, code: "KeyK", key: "k" }),
    ctrl: ev({ ctrlKey: true, code: "KeyK", key: "k" }),
  },
  "mermaid-import": {
    meta: ev({ metaKey: true, code: "KeyM", key: "m" }),
    ctrl: ev({ ctrlKey: true, code: "KeyM", key: "m" }),
  },
  "tidy-layout": {
    meta: ev({ metaKey: true, shiftKey: true, code: "KeyL", key: "l" }),
    ctrl: ev({ ctrlKey: true, shiftKey: true, code: "KeyL", key: "l" }),
  },
  "force-relayout": {
    meta: ev({
      metaKey: true,
      altKey: true,
      shiftKey: true,
      code: "KeyL",
      key: "l",
    }),
    ctrl: ev({
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      code: "KeyL",
      key: "l",
    }),
  },
  // DRW-219: ⌘⇧F / Ctrl+Shift+F.
  "fit-text": {
    meta: ev({ metaKey: true, shiftKey: true, code: "KeyF", key: "f" }),
    ctrl: ev({ ctrlKey: true, shiftKey: true, code: "KeyF", key: "f" }),
  },
  // copy-link default is ⇧⌘S (moved off ⌘⌥C — that's Chrome's Inspect-Element
  // DevTools accelerator on macOS and never reaches the page handler).
  "copy-link": {
    meta: ev({ metaKey: true, shiftKey: true, code: "KeyS", key: "S" }),
    ctrl: ev({ ctrlKey: true, shiftKey: true, code: "KeyS", key: "S" }),
  },
  "export-miro": {
    meta: ev({ metaKey: true, shiftKey: true, code: "KeyE", key: "e" }),
    ctrl: ev({ ctrlKey: true, shiftKey: true, code: "KeyE", key: "e" }),
  },
  "role-picker": {
    meta: ev({ metaKey: true, shiftKey: true, code: "KeyK", key: "k" }),
    ctrl: ev({ ctrlKey: true, shiftKey: true, code: "KeyK", key: "k" }),
  },
  "settings-popover": {
    meta: ev({ metaKey: true, shiftKey: true, code: "KeyP", key: "p" }),
    ctrl: ev({ ctrlKey: true, shiftKey: true, code: "KeyP", key: "p" }),
  },
};

describe("matchShortcut — defaults match their historical combos", () => {
  for (const cmd of SHORTCUT_REGISTRY) {
    const h = HISTORICAL[cmd.id]!;
    test(`${cmd.id}: ⌘ variant matches`, () => {
      expect(matchShortcut(cmd.defaultBinding, h.meta)).toBe(true);
    });
    test(`${cmd.id}: Ctrl variant matches`, () => {
      expect(matchShortcut(cmd.defaultBinding, h.ctrl)).toBe(true);
    });
  }
});

describe("matchShortcut — near-misses do NOT match", () => {
  test("prompt (⌘K) does NOT match when shift is held", () => {
    // ⌘⇧K is the role-picker, not prompt.
    expect(
      matchShortcut(
        getCommand("prompt")!.defaultBinding,
        ev({ metaKey: true, shiftKey: true, code: "KeyK", key: "k" }),
      ),
    ).toBe(false);
  });

  test("role-picker (⌘⇧K) does NOT match plain ⌘K", () => {
    expect(
      matchShortcut(
        getCommand("role-picker")!.defaultBinding,
        ev({ metaKey: true, code: "KeyK", key: "k" }),
      ),
    ).toBe(false);
  });

  test("tidy-layout (⌘⇧L) does NOT match ⌘⌥⇧L (force-relayout)", () => {
    expect(
      matchShortcut(
        getCommand("tidy-layout")!.defaultBinding,
        ev({
          metaKey: true,
          altKey: true,
          shiftKey: true,
          code: "KeyL",
          key: "l",
        }),
      ),
    ).toBe(false);
  });

  test("force-relayout (⌘⌥⇧L) does NOT match ⌘⇧L", () => {
    expect(
      matchShortcut(
        getCommand("force-relayout")!.defaultBinding,
        ev({ metaKey: true, shiftKey: true, code: "KeyL", key: "l" }),
      ),
    ).toBe(false);
  });

  test("copy-link (⇧⌘S) does NOT match ⌘S (no shift)", () => {
    expect(
      matchShortcut(
        getCommand("copy-link")!.defaultBinding,
        ev({ metaKey: true, code: "KeyS", key: "s" }),
      ),
    ).toBe(false);
  });

  test("wrong key does NOT match (⌘K vs ⌘L)", () => {
    expect(
      matchShortcut(
        getCommand("prompt")!.defaultBinding,
        ev({ metaKey: true, code: "KeyL", key: "l" }),
      ),
    ).toBe(false);
  });

  test("no modifier does NOT match a mod-binding", () => {
    expect(
      matchShortcut(
        getCommand("prompt")!.defaultBinding,
        ev({ code: "KeyK", key: "k" }),
      ),
    ).toBe(false);
  });
});

describe("matchShortcut — macOS Opt emits accents; e.code wins (force-relayout ⌥⇧⌘L)", () => {
  test("e.code=KeyL, e.key='¬' still matches via code", () => {
    // macOS Opt+L emits the '¬' glyph for e.key; we match on e.code so it holds.
    expect(
      matchShortcut(
        getCommand("force-relayout")!.defaultBinding,
        ev({ metaKey: true, altKey: true, shiftKey: true, code: "KeyL", key: "¬" }),
      ),
    ).toBe(true);
  });

  test("fallback: no code reported but key='l' matches", () => {
    // Some environments / doubles only set key.
    expect(
      matchShortcut(
        getCommand("force-relayout")!.defaultBinding,
        ev({ metaKey: true, altKey: true, shiftKey: true, code: "", key: "l" }),
      ),
    ).toBe(true);
  });
});

describe("bindingFromEvent", () => {
  test("derives binding from a real chord", () => {
    const b = bindingFromEvent(
      ev({ metaKey: true, shiftKey: true, code: "KeyL", key: "l" }),
    );
    expect(b).toEqual({ mod: true, alt: false, shift: true, code: "KeyL" });
  });

  test("ctrl maps to mod:true", () => {
    const b = bindingFromEvent(ev({ ctrlKey: true, code: "KeyK", key: "k" }));
    expect(b?.mod).toBe(true);
  });

  test("ignores bare Meta press (by code)", () => {
    expect(
      bindingFromEvent(ev({ metaKey: true, code: "MetaLeft", key: "Meta" })),
    ).toBeNull();
  });

  test("ignores bare Shift press (by key)", () => {
    expect(
      bindingFromEvent(ev({ shiftKey: true, code: "ShiftRight", key: "Shift" })),
    ).toBeNull();
  });

  test("ignores bare Control / Alt presses", () => {
    expect(
      bindingFromEvent(ev({ ctrlKey: true, code: "ControlLeft", key: "Control" })),
    ).toBeNull();
    expect(
      bindingFromEvent(ev({ altKey: true, code: "AltLeft", key: "Alt" })),
    ).toBeNull();
  });
});

describe("formatBinding — mac glyphs", () => {
  test("⌘K", () => {
    expect(formatBinding({ mod: true, code: "KeyK" })).toBe("⌘K");
  });
  test("⌘⇧L", () => {
    expect(formatBinding({ mod: true, shift: true, code: "KeyL" })).toBe("⇧⌘L");
  });
  test("⌘⌥⇧L", () => {
    expect(
      formatBinding({ mod: true, alt: true, shift: true, code: "KeyL" }),
    ).toBe("⌥⇧⌘L");
  });
  test("⌘⌥C", () => {
    expect(formatBinding({ mod: true, alt: true, code: "KeyC" })).toBe("⌥⌘C");
  });
});

describe("codeToKey / bindingsEqual", () => {
  test("codeToKey letters", () => {
    expect(codeToKey("KeyC")).toBe("c");
    expect(codeToKey("KeyL")).toBe("l");
  });
  test("bindingsEqual normalizes undefined vs false modifiers", () => {
    const a: Binding = { code: "KeyK", mod: true };
    const b: Binding = { code: "KeyK", mod: true, alt: false, shift: false };
    expect(bindingsEqual(a, b)).toBe(true);
  });
  test("bindingsEqual distinguishes different keys", () => {
    expect(
      bindingsEqual({ code: "KeyK", mod: true }, { code: "KeyL", mod: true }),
    ).toBe(false);
  });
});
