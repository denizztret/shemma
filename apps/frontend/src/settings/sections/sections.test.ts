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
import { DensitySection } from "./DensitySection";
import {
  LayoutSettingsSection,
  type LayoutSettingsSectionProps,
  type LayoutSettingsValue,
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
    onAdvanced: () => {},
    onReset: () => {},
    showReset: false,
    ...overrides,
  };
}

describe("LayoutSettingsSection — rendering", () => {
  test("exports a component", () => {
    expect(typeof LayoutSettingsSection).toBe("function");
  });

  test("renders the Advanced link; NO Compact/Normal/Roomy preset buttons (DRW-239)", () => {
    const tree = LayoutSettingsSection(defaultProps());
    const buttons = findAllButtons(tree);
    // density replaced the preset buttons; this section is now engine + links only
    expect(
      buttons.some((b) => typeof b.props["data-preset"] === "string"),
    ).toBe(false);
    expect(buttons.some((b) => b.props["data-role"] === "advanced")).toBe(true);
    expect(buttons.some((b) => b.props["data-role"] === "reset")).toBe(false);
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

describe("DensitySection — slider (DRW-239)", () => {
  function findDensitySlider(tree: unknown): AnyElement | undefined {
    return findAll(
      tree,
      (el) => el.type === "input" && el.props["data-role"] === "density",
    )[0];
  }

  test("renders a range slider", () => {
    const tree = DensitySection({
      onDensity: { start: () => {}, change: () => {}, end: () => {} },
    });
    const slider = findDensitySlider(tree);
    expect(slider).toBeDefined();
    expect(slider?.props.type).toBe("range");
  });

  test("gesture wiring: pointer-down→start, input→change(value), pointer-up→end + reset to centre", () => {
    const calls: string[] = [];
    let lastK = -1;
    const tree = DensitySection({
      onDensity: {
        start: () => calls.push("start"),
        change: (k) => {
          calls.push("change");
          lastK = k;
        },
        end: () => calls.push("end"),
      },
    });
    const slider = findDensitySlider(tree);
    if (!slider) throw new Error("density slider not found");
    (slider.props.onPointerDown as () => void)();
    (slider.props.onInput as (e: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: "1.6" },
    });
    const ct = { value: "1.6" };
    (slider.props.onPointerUp as (e: { currentTarget: { value: string } }) => void)({
      currentTarget: ct,
    });
    expect(calls).toEqual(["start", "change", "end"]);
    expect(lastK).toBe(1.6);
    expect(ct.value).toBe("1"); // released → snaps back to centre
  });
});
