import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import { selectionFooterCounter, selectionHasContainer } from "./SelectionPanel";

type AnyElement = ReactElement<{ children?: unknown; className?: string; [key: string]: unknown }>;

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

function renderText(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (isValidElement(node)) {
    return renderText((node as AnyElement).props.children);
  }
  return "";
}

function hasText(root: unknown, needle: string): boolean {
  return flatten(root).some((el) => renderText(el).includes(needle));
}

function hasClassName(root: unknown, className: string): boolean {
  return flatten(root).some((el) => {
    const cls = el.props.className;
    return typeof cls === "string" && cls.split(/\s+/).includes(className);
  });
}

function hasComponent(root: unknown, componentName: string): boolean {
  return flatten(root).some((el) => {
    const t = el.type as unknown;
    if (typeof t === "function" && (t as { name?: string }).name === componentName) return true;
    return false;
  });
}

function findComponent(root: unknown, componentName: string): AnyElement | null {
  return flatten(root).find((el) => {
    const t = el.type as unknown;
    return typeof t === "function" && (t as { name?: string }).name === componentName;
  }) ?? null;
}

describe("selectionFooterCounter", () => {
  test("1 контейнер only", () => {
    expect(selectionFooterCounter({ containers: 1, nodes: 0 })).toBe("1 контейнер");
  });
  test("2 контейнера + 5 узлов", () => {
    expect(selectionFooterCounter({ containers: 2, nodes: 5 })).toBe("2 контейнера, 5 узлов");
  });
  test("7 элементов only", () => {
    expect(selectionFooterCounter({ containers: 0, nodes: 7 })).toBe("7 элементов");
  });
  test("21 контейнер (правило плюрализации)", () => {
    expect(selectionFooterCounter({ containers: 21, nodes: 0 })).toBe("21 контейнер");
  });
  test("12 элементов (тыс. — many)", () => {
    expect(selectionFooterCounter({ containers: 0, nodes: 12 })).toBe("12 элементов");
  });
});

describe("selectionHasContainer", () => {
  test("true when containers > 0", () => {
    expect(selectionHasContainer({ containers: 1, nodes: 0 })).toBe(true);
  });
  test("false when containers == 0", () => {
    expect(selectionHasContainer({ containers: 0, nodes: 5 })).toBe(false);
  });
});

import { NodePanel } from "./NodePanel";

describe("NodePanel", () => {
  test("exports a component", () => {
    expect(typeof NodePanel).toBe("function");
  });
});

import { BoardPanel } from "./BoardPanel";
import type { LayoutParams } from "@shemma/domain";

const defaultEffective: LayoutParams = {
  defaultDirection: "TB",
  autoDirectionEnabled: true,
  midpointDistribution: "even",
  nodeMinWidth: 120,
  nodeMinHeight: 60,
  nodePadding: 24,
  containerPadding: 32,
  containerLabelHeight: 24,
  edgeSpacing: 16,
  edgeNodeSpacing: 24,
  edgeLabelMaxWidth: 120,
  edgeLabelMaxLines: 2,
  edgeLabelMargin: 4,
  edgeLabelFontSize: 11,
};

function renderBoardPanel() {
  return BoardPanel({
    effective: defaultEffective,
    onDirectionChange: () => {},
    onPresetSelect: () => {},
    onToggleAutoDirection: () => {},
    onMidpointModeChange: () => {},
    onOpenAdvanced: () => {},
  });
}

describe("BoardPanel", () => {
  test("exports a component", () => {
    expect(typeof BoardPanel).toBe("function");
  });

  test("renders header \"По умолчанию\"", () => {
    const tree = renderBoardPanel();
    expect(hasText(tree, "По умолчанию")).toBe(true);
  });

  test("renders top badge \"Для нового содержимого\"", () => {
    const tree = renderBoardPanel();
    expect(hasText(tree, "Для нового содержимого")).toBe(true);
    expect(hasClassName(tree, "settings-popover__badge")).toBe(true);
  });
});

import { BoardPanelAdvanced } from "./BoardPanelAdvanced";

function renderBoardPanelAdvanced() {
  return BoardPanelAdvanced({
    effective: defaultEffective,
    onFieldChange: () => {},
    onReset: () => {},
    onBack: () => {},
  });
}

describe("BoardPanelAdvanced", () => {
  test("exports a component", () => {
    expect(typeof BoardPanelAdvanced).toBe("function");
  });

  test("renders top badge \"Для нового содержимого\"", () => {
    const tree = renderBoardPanelAdvanced();
    expect(hasText(tree, "Для нового содержимого")).toBe(true);
    expect(hasClassName(tree, "settings-popover__badge")).toBe(true);
  });

  test("renders helper text about defaults", () => {
    const tree = renderBoardPanelAdvanced();
    expect(hasText(tree, "Эти значения работают как defaults для всего room")).toBe(true);
    expect(hasClassName(tree, "settings-popover__hint")).toBe(true);
  });
});

import { SelectionPanel, type SelectionPanelProps } from "./SelectionPanel";
import type { LayoutSettingsValue } from "../sections/LayoutSettingsSection";

const defaultLayoutSettings: LayoutSettingsValue = {
  preset: "normal",
  autoDirection: true,
  midpoint: "even",
};

function renderSelectionPanel(overrides: Partial<SelectionPanelProps> = {}): ReturnType<typeof SelectionPanel> {
  const props: SelectionPanelProps = {
    counts: { containers: 1, nodes: 0 },
    showContainerSections: true,
    direction: "TB",
    onDirectionChange: () => {},
    layoutSettings: defaultLayoutSettings,
    onPreset: () => {},
    onAutoDirection: () => {},
    onMidpoint: () => {},
    onAdvanced: () => {},
    onReset: () => {},
    showReset: false,
    onLayoutAction: () => {},
    pinValues: { size: false, position: false },
    onPinToggle: () => {},
    pending: null,
    ...overrides,
  };
  return SelectionPanel(props);
}

describe("SelectionPanel", () => {
  test("showContainerSections=true (1 container) → Direction + LayoutSettings rendered", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 0 },
      showContainerSections: true,
    });
    expect(hasComponent(tree, "DirectionSection")).toBe(true);
    expect(hasComponent(tree, "LayoutSettingsSection")).toBe(true);
  });

  test("showContainerSections=false (mixed) → Direction + LayoutSettings hidden; Pin + LayoutActions visible", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 1 },
      showContainerSections: false,
    });
    expect(hasComponent(tree, "DirectionSection")).toBe(false);
    expect(hasComponent(tree, "LayoutSettingsSection")).toBe(false);
    expect(hasComponent(tree, "PinSection")).toBe(true);
    expect(hasComponent(tree, "LayoutActionsSection")).toBe(true);
  });

  test("showReset=true → Reset link visible (showReset prop пробрасывается)", () => {
    const tree = renderSelectionPanel({
      showContainerSections: true,
      showReset: true,
    });
    const layoutSettings = findComponent(tree, "LayoutSettingsSection");
    expect(layoutSettings).not.toBeNull();
    expect(layoutSettings!.props.showReset).toBe(true);
  });

  test("showReset=false → Reset hidden (showReset prop = false)", () => {
    const tree = renderSelectionPanel({
      showContainerSections: true,
      showReset: false,
    });
    const layoutSettings = findComponent(tree, "LayoutSettingsSection");
    expect(layoutSettings).not.toBeNull();
    expect(layoutSettings!.props.showReset).toBe(false);
  });

  test("does NOT render badge \"Для нового содержимого\"", () => {
    const tree = renderSelectionPanel({
      showContainerSections: true,
      showReset: true,
    });
    expect(hasText(tree, "Для нового содержимого")).toBe(false);
    expect(hasClassName(tree, "settings-popover__badge")).toBe(false);
  });
});
