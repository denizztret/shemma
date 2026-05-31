/**
 * Pure shortcut-binding matching layer (no React / DOM-global deps).
 *
 * A `Binding` is a normalized description of a keyboard shortcut:
 *   - `mod`   — cmd-or-ctrl (preserves the historical `metaKey || ctrlKey`
 *               semantics every shemma handler used).
 *   - `alt`   — Alt / Option.
 *   - `shift` — Shift.
 *   - `code`  — a `KeyboardEvent.code` (e.g. "KeyC", "KeyL", "KeyK"). Matching on
 *               `code` is robust to macOS Opt producing accented characters
 *               (Opt+C → `ç`): `e.code` stays "KeyC" regardless of the glyph.
 *
 * Matching falls back to `e.key.toLowerCase()` when the platform does not report
 * `code` so the layer also works in environments / test doubles that only set
 * `key`.
 */

export type Binding = {
  /** cmd (mac) or ctrl (win/linux). */
  mod?: boolean;
  /** Alt / Option. */
  alt?: boolean;
  /** Shift. */
  shift?: boolean;
  /** A KeyboardEvent.code, e.g. "KeyC". */
  code: string;
};

/** Minimal shape of the KeyboardEvent fields the matcher reads. */
export type KeyboardEventLike = {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code: string;
  key: string;
};

/**
 * Map a `KeyboardEvent.code` to the single lowercase character `e.key` would
 * carry when no modifier remaps the glyph. Only the cases shemma needs (letter
 * keys) are mapped; anything else returns the code lowercased as a best effort.
 */
export function codeToKey(code: string): string {
  if (code.length === 4 && code.startsWith("Key")) {
    // "KeyC" → "c"
    return code.charAt(3).toLowerCase();
  }
  if (code.length === 6 && code.startsWith("Digit")) {
    // "Digit1" → "1"
    return code.charAt(5);
  }
  return code.toLowerCase();
}

/**
 * Match a binding against a keydown event. Returns true iff every modifier
 * matches exactly (mod = meta-or-ctrl) AND the key matches by `code` or by the
 * `e.key.toLowerCase()` fallback.
 */
export function matchShortcut(b: Binding, e: KeyboardEventLike): boolean {
  // Coerce modifier fields to booleans: real DOM events always carry booleans,
  // but partial test doubles / defensive callers may leave them undefined.
  const mod = !!(e.metaKey || e.ctrlKey);
  if (mod !== !!b.mod) return false;
  if (!!e.altKey !== !!b.alt) return false;
  if (!!e.shiftKey !== !!b.shift) return false;
  const key = (e.key ?? "").toLowerCase();
  return e.code === b.code || key === codeToKey(b.code);
}

const BARE_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

const BARE_MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

/**
 * Derive a Binding from a keydown event. Returns null if the pressed key is
 * itself only a modifier (Meta/Control/Alt/Shift) so capture flows ignore bare
 * modifier presses while the user is composing a chord.
 */
export function bindingFromEvent(e: KeyboardEventLike): Binding | null {
  if (BARE_MODIFIER_CODES.has(e.code) || BARE_MODIFIER_KEYS.has(e.key)) {
    return null;
  }
  return {
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code: e.code,
  };
}

/**
 * Human-readable label for a binding using mac glyphs:
 *   mod → ⌘, alt → ⌥, shift → ⇧, then the key letter.
 * Order mirrors the macOS convention (⌃⌥⇧⌘ Key); here mod is rendered last
 * before the key to match Apple's ⌥⇧⌘K style.
 */
export function formatBinding(b: Binding): string {
  const parts: string[] = [];
  // macOS convention renders modifiers ⌃⌥⇧⌘ then the key. We only use mod
  // (⌘/Ctrl), ⌥, ⇧.
  if (b.alt) parts.push("⌥");
  if (b.shift) parts.push("⇧");
  if (b.mod) parts.push("⌘");
  parts.push(codeToKey(b.code).toUpperCase());
  return parts.join("");
}

/** Structural equality of two bindings (modifiers normalized to booleans). */
export function bindingsEqual(a: Binding, b: Binding): boolean {
  return (
    !!a.mod === !!b.mod &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift &&
    a.code === b.code
  );
}
