import { describe, expect, test } from "bun:test";
import { DIRECTION_OPTIONS } from "./DirectionSection";

describe("DIRECTION_OPTIONS", () => {
  test("contains TB / LR / BT / RL / custom in that order", () => {
    expect(DIRECTION_OPTIONS.map((o) => o.value)).toEqual(["TB", "LR", "BT", "RL", "custom"]);
  });

  test("each option has a label", () => {
    expect(DIRECTION_OPTIONS.every((o) => typeof o.label === "string" && o.label.length > 0)).toBe(true);
  });
});
