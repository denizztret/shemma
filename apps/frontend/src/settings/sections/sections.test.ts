import { describe, expect, test } from "bun:test";
import { DIRECTION_OPTIONS } from "./DirectionSection";
import { LayoutActionsSection } from "./LayoutActionsSection";

describe("DIRECTION_OPTIONS", () => {
  test("contains TB / LR / BT / RL / custom in that order", () => {
    expect(DIRECTION_OPTIONS.map((o) => o.value)).toEqual([
      "TB",
      "LR",
      "BT",
      "RL",
      "custom",
    ]);
  });

  test("each option has a label", () => {
    expect(
      DIRECTION_OPTIONS.every(
        (o) => typeof o.label === "string" && o.label.length > 0,
      ),
    ).toBe(true);
  });
});

describe("LayoutActionsSection", () => {
  test("exports a component", () => {
    expect(typeof LayoutActionsSection).toBe("function");
  });
});

import { PIN_FIELDS, aggregatePinState } from "./PinSection";

describe("PIN_FIELDS", () => {
  test("has size + position", () => {
    expect(PIN_FIELDS.map((f) => f.field)).toEqual(["size", "position"]);
  });
});

describe("aggregatePinState", () => {
  test("empty → off", () => {
    expect(aggregatePinState([])).toBe("off");
  });
  test("all true → on", () => {
    expect(aggregatePinState([true, true, true])).toBe("on");
    expect(aggregatePinState([true])).toBe("on");
  });
  test("all false → off", () => {
    expect(aggregatePinState([false, false])).toBe("off");
    expect(aggregatePinState([false])).toBe("off");
  });
  test("heterogeneous → mixed", () => {
    expect(aggregatePinState([true, false])).toBe("mixed");
    expect(aggregatePinState([false, true, false])).toBe("mixed");
  });
});

import { RoleSection } from "./RoleSection";

describe("RoleSection", () => {
  test("exports a component", () => {
    expect(typeof RoleSection).toBe("function");
  });
});

import { StylesSection } from "./StylesSection";

describe("StylesSection", () => {
  test("exports a component", () => {
    expect(typeof StylesSection).toBe("function");
  });
});

import { type ReactElement, isValidElement } from "react";
import {
  LayoutSettingsSection,
  type LayoutSettingsSectionProps,
  type LayoutSettingsValue,
  PRESET_HINTS,
  PRESET_LABELS,
} from "./LayoutSettingsSection";

type AnyElement = ReactElement<{ children?: unknown; [key: string]: unknown }>;

function flatten(node: unknown): AnyElement[] {
  if (node === null || node === undefined || node === false || node === true)
    return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (isValidElement(node)) {
    const el = node as AnyElement;
    const childResults = flatten(el.props.children);
    return [el, ...childResults];
  }
  return [];
}

function findAll(
  node: unknown,
  predicate: (el: AnyElement) => boolean,
): AnyElement[] {
  return flatten(node).filter(predicate);
}

function findAllButtons(node: unknown): AnyElement[] {
  return findAll(node, (el) => el.type === "button");
}

function defaultProps(
  overrides: Partial<LayoutSettingsSectionProps> = {},
): LayoutSettingsSectionProps {
  return {
    current: { preset: null },
    onPreset: () => {},
    onAdvanced: () => {},
    onReset: () => {},
    showReset: false,
    ...overrides,
  };
}

describe("LayoutSettingsSection — constants", () => {
  test("PRESET_LABELS maps compact/normal/loose to Compact/Normal/Roomy", () => {
    expect(PRESET_LABELS).toEqual({
      compact: "Compact",
      normal: "Normal",
      loose: "Roomy",
    });
  });

  test("PRESET_HINTS provides non-empty hint for each preset", () => {
    (["compact", "normal", "loose"] as const).forEach((p) => {
      expect(typeof PRESET_HINTS[p]).toBe("string");
      expect(PRESET_HINTS[p].length).toBeGreaterThan(0);
    });
  });
});

describe("LayoutSettingsSection — rendering", () => {
  test("exports a component", () => {
    expect(typeof LayoutSettingsSection).toBe("function");
  });

  test("renders 3 preset buttons + Advanced link (no Reset when showReset=false)", () => {
    const tree = LayoutSettingsSection(defaultProps());
    const buttons = findAllButtons(tree);
    // 3 presets + 1 Advanced = 4
    expect(buttons.length).toBe(4);

    const presetButtons = buttons.filter(
      (b) => typeof b.props["data-preset"] === "string",
    );
    expect(presetButtons.map((b) => b.props["data-preset"])).toEqual([
      "compact",
      "normal",
      "loose",
    ]);

    // Vestigial controls removed (auto-direction, even/centered midpoints).
    expect(buttons.some((b) => b.props["data-role"] === "auto-direction")).toBe(
      false,
    );
    expect(
      buttons.some((b) => typeof b.props["data-midpoint"] === "string"),
    ).toBe(false);

    expect(buttons.some((b) => b.props["data-role"] === "advanced")).toBe(true);
    expect(buttons.some((b) => b.props["data-role"] === "reset")).toBe(false);
  });

  test("preset click → onPreset called with preset value", () => {
    const calls: Array<"compact" | "normal" | "loose"> = [];
    const tree = LayoutSettingsSection(
      defaultProps({ onPreset: (p) => calls.push(p) }),
    );
    const compactBtn = findAllButtons(tree).find(
      (b) => b.props["data-preset"] === "compact",
    );
    expect(compactBtn).toBeDefined();
    (compactBtn!.props.onClick as () => void)();
    expect(calls).toEqual(["compact"]);
  });

  test("active preset gets settings-btn--on; others don't", () => {
    const tree = LayoutSettingsSection(
      defaultProps({
        current: { preset: "compact" },
      }),
    );
    const buttons = findAllButtons(tree).filter(
      (b) => typeof b.props["data-preset"] === "string",
    );
    const byPreset = Object.fromEntries(
      buttons.map((b) => [b.props["data-preset"], b.props.className as string]),
    );
    expect(byPreset.compact).toContain("settings-btn--on");
    expect(byPreset.normal ?? "").not.toContain("settings-btn--on");
    expect(byPreset.loose ?? "").not.toContain("settings-btn--on");
  });

  test("showReset=true renders Reset button; false hides it", () => {
    const withReset = LayoutSettingsSection(defaultProps({ showReset: true }));
    expect(
      findAllButtons(withReset).some((b) => b.props["data-role"] === "reset"),
    ).toBe(true);

    const withoutReset = LayoutSettingsSection(
      defaultProps({ showReset: false }),
    );
    expect(
      findAllButtons(withoutReset).some(
        (b) => b.props["data-role"] === "reset",
      ),
    ).toBe(false);
  });

  test("LayoutSettingsValue accepts null preset (type-level smoke via runtime usage)", () => {
    const v: LayoutSettingsValue = {
      preset: null,
    };
    expect(v.preset).toBeNull();
  });
});
