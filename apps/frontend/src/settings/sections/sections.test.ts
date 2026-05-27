import { describe, expect, test } from "bun:test";
import { DIRECTION_OPTIONS } from "./DirectionSection";
import { LAYOUT_ACTIONS } from "./LayoutSection";

describe("DIRECTION_OPTIONS", () => {
  test("contains TB / LR / BT / RL / custom in that order", () => {
    expect(DIRECTION_OPTIONS.map((o) => o.value)).toEqual(["TB", "LR", "BT", "RL", "custom"]);
  });

  test("each option has a label", () => {
    expect(DIRECTION_OPTIONS.every((o) => typeof o.label === "string" && o.label.length > 0)).toBe(true);
  });
});

describe("LAYOUT_ACTIONS", () => {
  test("exposes tidy + force-unpin with shortcuts", () => {
    expect(LAYOUT_ACTIONS.map((a) => a.id)).toEqual(["tidy", "force-unpin"]);
    expect(LAYOUT_ACTIONS.find((a) => a.id === "tidy")?.shortcut).toBe("⌘⇧L");
    expect(LAYOUT_ACTIONS.find((a) => a.id === "force-unpin")?.shortcut).toBe("⌘⇧⌥L");
  });
});

import { PIN_FIELDS } from "./PinSection";

describe("PIN_FIELDS", () => {
  test("has size + position", () => {
    expect(PIN_FIELDS.map((f) => f.field)).toEqual(["size", "position"]);
  });
});
