import { describe, expect, test } from "bun:test";
import { DIRECTION_OPTIONS } from "./DirectionSection";
import { LAYOUT_ACTIONS, LayoutActionsSection } from "./LayoutActionsSection";

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

describe("LayoutActionsSection", () => {
  test("exports a component", () => {
    expect(typeof LayoutActionsSection).toBe("function");
  });
});

import { PIN_FIELDS } from "./PinSection";

describe("PIN_FIELDS", () => {
  test("has size + position", () => {
    expect(PIN_FIELDS.map((f) => f.field)).toEqual(["size", "position"]);
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

import {
  LayoutSettingsSection,
  PRESET_LABELS,
  PRESET_HINTS,
  type LayoutSettingsValue,
  type LayoutSettingsSectionProps,
} from "./LayoutSettingsSection";
import { isValidElement, type ReactElement } from "react";

type AnyElement = ReactElement<{ children?: unknown; [key: string]: unknown }>;

function flatten(node: unknown): AnyElement[] {
  if (node === null || node === undefined || node === false || node === true) return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (isValidElement(node)) {
    const el = node as AnyElement;
    const childResults = flatten(el.props.children);
    return [el, ...childResults];
  }
  return [];
}

function findAll(node: unknown, predicate: (el: AnyElement) => boolean): AnyElement[] {
  return flatten(node).filter(predicate);
}

function findAllButtons(node: unknown): AnyElement[] {
  return findAll(node, (el) => el.type === "button");
}

function defaultProps(overrides: Partial<LayoutSettingsSectionProps> = {}): LayoutSettingsSectionProps {
  return {
    current: { preset: null, autoDirection: null, midpoint: null },
    onPreset: () => {},
    onAutoDirection: () => {},
    onMidpoint: () => {},
    onAdvanced: () => {},
    onReset: () => {},
    showReset: false,
    ...overrides,
  };
}

describe("LayoutSettingsSection — constants", () => {
  test("PRESET_LABELS maps compact/normal/loose to Compact/Normal/Roomy", () => {
    expect(PRESET_LABELS).toEqual({ compact: "Compact", normal: "Normal", loose: "Roomy" });
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

  test("renders 3 preset buttons + autoDirection toggle + 2 midpoint buttons + Advanced link (no Reset when showReset=false)", () => {
    const tree = LayoutSettingsSection(defaultProps());
    const buttons = findAllButtons(tree);
    // 3 presets + 1 autoDirection + 2 midpoint + 1 Advanced = 7
    expect(buttons.length).toBe(7);

    const presetButtons = buttons.filter((b) => typeof b.props["data-preset"] === "string");
    expect(presetButtons.map((b) => b.props["data-preset"])).toEqual(["compact", "normal", "loose"]);

    const midpointButtons = buttons.filter((b) => typeof b.props["data-midpoint"] === "string");
    expect(midpointButtons.map((b) => b.props["data-midpoint"])).toEqual(["even", "fixed-0.5"]);

    expect(buttons.some((b) => b.props["data-role"] === "auto-direction")).toBe(true);
    expect(buttons.some((b) => b.props["data-role"] === "advanced")).toBe(true);
    expect(buttons.some((b) => b.props["data-role"] === "reset")).toBe(false);
  });

  test("preset click → onPreset called with preset value", () => {
    const calls: Array<"compact" | "normal" | "loose"> = [];
    const tree = LayoutSettingsSection(defaultProps({ onPreset: (p) => calls.push(p) }));
    const compactBtn = findAllButtons(tree).find((b) => b.props["data-preset"] === "compact");
    expect(compactBtn).toBeDefined();
    (compactBtn!.props.onClick as () => void)();
    expect(calls).toEqual(["compact"]);
  });

  test("active preset gets settings-btn--on; others don't", () => {
    const tree = LayoutSettingsSection(defaultProps({ current: { preset: "compact", autoDirection: null, midpoint: null } }));
    const buttons = findAllButtons(tree).filter((b) => typeof b.props["data-preset"] === "string");
    const byPreset = Object.fromEntries(buttons.map((b) => [b.props["data-preset"], b.props.className as string]));
    expect(byPreset.compact).toContain("settings-btn--on");
    expect(byPreset.normal ?? "").not.toContain("settings-btn--on");
    expect(byPreset.loose ?? "").not.toContain("settings-btn--on");
  });

  test("showReset=true renders Reset button; false hides it", () => {
    const withReset = LayoutSettingsSection(defaultProps({ showReset: true }));
    expect(findAllButtons(withReset).some((b) => b.props["data-role"] === "reset")).toBe(true);

    const withoutReset = LayoutSettingsSection(defaultProps({ showReset: false }));
    expect(findAllButtons(withoutReset).some((b) => b.props["data-role"] === "reset")).toBe(false);
  });

  test("autoDirection=null → button has settings-btn--indeterminate, no settings-btn--on", () => {
    const tree = LayoutSettingsSection(defaultProps({ current: { preset: null, autoDirection: null, midpoint: null } }));
    const autoBtn = findAllButtons(tree).find((b) => b.props["data-role"] === "auto-direction");
    expect(autoBtn).toBeDefined();
    const className = autoBtn!.props.className as string;
    expect(className).toContain("settings-btn--indeterminate");
    expect(className).not.toContain("settings-btn--on");
  });

  test("autoDirection=true → button has settings-btn--on, no indeterminate", () => {
    const tree = LayoutSettingsSection(defaultProps({ current: { preset: null, autoDirection: true, midpoint: null } }));
    const autoBtn = findAllButtons(tree).find((b) => b.props["data-role"] === "auto-direction");
    const className = autoBtn!.props.className as string;
    expect(className).toContain("settings-btn--on");
    expect(className).not.toContain("settings-btn--indeterminate");
  });

  test("midpoint=null → neither button is highlighted (no settings-btn--on)", () => {
    const tree = LayoutSettingsSection(defaultProps({ current: { preset: null, autoDirection: null, midpoint: null } }));
    const buttons = findAllButtons(tree).filter((b) => typeof b.props["data-midpoint"] === "string");
    expect(buttons.length).toBe(2);
    buttons.forEach((b) => {
      expect(b.props.className as string).not.toContain("settings-btn--on");
    });
  });

  test("midpoint='even' → only the even button is highlighted", () => {
    const tree = LayoutSettingsSection(defaultProps({ current: { preset: null, autoDirection: null, midpoint: "even" } }));
    const buttons = findAllButtons(tree).filter((b) => typeof b.props["data-midpoint"] === "string");
    const byMid = Object.fromEntries(buttons.map((b) => [b.props["data-midpoint"], b.props.className as string]));
    expect(byMid.even).toContain("settings-btn--on");
    expect(byMid["fixed-0.5"] ?? "").not.toContain("settings-btn--on");
  });

  test("LayoutSettingsValue accepts null variants (type-level smoke via runtime usage)", () => {
    const v: LayoutSettingsValue = { preset: null, autoDirection: null, midpoint: null };
    expect(v.preset).toBeNull();
    expect(v.autoDirection).toBeNull();
    expect(v.midpoint).toBeNull();
  });
});
