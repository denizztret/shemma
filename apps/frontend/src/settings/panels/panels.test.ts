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

function hasAttribute(root: unknown, attr: string, valueMatcher: string | RegExp): boolean {
  return flatten(root).some((el) => {
    const v = (el.props as Record<string, unknown>)[attr];
    if (typeof v !== "string") return false;
    return typeof valueMatcher === "string" ? v.includes(valueMatcher) : valueMatcher.test(v);
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
import { DEFAULT_STYLE_DEFAULTS } from "@shemma/domain";

const defaultEffective: LayoutParams = {
  defaultDirection: "TB",
  autoDirectionEnabled: true,
  midpointDistribution: "even",
  anchorOffsetMode: "distribute",
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

function renderBoardPanel(overrides: Partial<Parameters<typeof BoardPanel>[0]> = {}) {
  return BoardPanel({
    effective: defaultEffective,
    onDirectionChange: () => {},
    onPresetSelect: () => {},
    onOpenAdvanced: () => {},
    onOpenShortcuts: () => {},
    styleEffective: DEFAULT_STYLE_DEFAULTS,
    onStyleDash: () => {},
    onStyleFont: () => {},
    onStyleSize: () => {},
    styleArrowKind: null,
    onStyleArrowKind: () => {},
    containerTitlePosition: "inside-center",
    onContainerTitlePositionChange: () => {},
    ...overrides,
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

  test("header has tooltip about defaults semantics", () => {
    const tree = renderBoardPanel();
    // h2 title carries title= attribute with defaults explanation
    expect(hasAttribute(tree, "data-tooltip", /Применяется к новому содержимому/)).toBe(true);
  });

  test("renders the «Горячие клавиши» drill-down link", () => {
    const tree = renderBoardPanel();
    expect(hasAttribute(tree, "data-role", "shortcuts")).toBe(true);
    expect(hasText(tree, "Горячие клавиши")).toBe(true);
  });

  test("«Горячие клавиши» button invokes onOpenShortcuts", () => {
    let opened = false;
    const tree = renderBoardPanel({
      onOpenShortcuts: () => {
        opened = true;
      },
    });
    const btn = flatten(tree).find(
      (el) => (el.props as Record<string, unknown>)["data-role"] === "shortcuts",
    );
    const onClick = btn?.props.onClick as (() => void) | undefined;
    onClick?.();
    expect(opened).toBe(true);
  });

  // ---- DRW-207: тип стрелок (board default) ----

  test("renders ArrowKindSection with current=styleArrowKind", () => {
    const tree = renderBoardPanel({ styleArrowKind: "elbow" });
    const section = findComponent(tree, "ArrowKindSection");
    expect(section).not.toBeNull();
    expect(section!.props.current).toBe("elbow");
  });

  test("ArrowKindSection receives onStyleArrowKind as onChange", () => {
    let picked: string | null = null;
    const tree = renderBoardPanel({
      onStyleArrowKind: (v: "arc" | "elbow") => {
        picked = v;
      },
    });
    const section = findComponent(tree, "ArrowKindSection");
    const onChange = section?.props.onChange as ((v: string) => void) | undefined;
    onChange?.("elbow");
    expect(picked).toBe("elbow" as never);
  });
});

// ---- DRW-207: ArrowKindSection (direct render) ----

import { ArrowKindSection } from "../sections/ArrowKindSection";

describe("ArrowKindSection", () => {
  test("renders arc and elbow buttons", () => {
    const tree = ArrowKindSection({ current: null, onChange: () => {} });
    expect(hasAttribute(tree, "data-arrow-kind", "arc")).toBe(true);
    expect(hasAttribute(tree, "data-arrow-kind", "elbow")).toBe(true);
  });

  test("current=null → no button highlighted (unset tri-state)", () => {
    const tree = ArrowKindSection({ current: null, onChange: () => {} });
    const buttons = flatten(tree).filter(
      (el) => typeof (el.props as Record<string, unknown>)["data-arrow-kind"] === "string",
    );
    expect(buttons.length).toBe(2);
    for (const b of buttons) {
      expect(String(b.props.className)).not.toContain("settings-btn--on");
    }
  });

  test("current=elbow → elbow button highlighted", () => {
    const tree = ArrowKindSection({ current: "elbow", onChange: () => {} });
    const btn = flatten(tree).find(
      (el) => (el.props as Record<string, unknown>)["data-arrow-kind"] === "elbow",
    );
    expect(String(btn?.props.className)).toContain("settings-btn--on");
  });

  test("button click invokes onChange with kind value", () => {
    let picked: string | null = null;
    const tree = ArrowKindSection({
      current: null,
      onChange: (v) => {
        picked = v;
      },
    });
    const btn = flatten(tree).find(
      (el) => (el.props as Record<string, unknown>)["data-arrow-kind"] === "arc",
    );
    const onClick = btn?.props.onClick as (() => void) | undefined;
    onClick?.();
    expect(picked).toBe("arc" as never);
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

  test("header has tooltip about defaults semantics", () => {
    const tree = renderBoardPanelAdvanced();
    expect(hasAttribute(tree, "data-tooltip", /Применяется к новому содержимому/)).toBe(true);
  });
});

import { SelectionPanel, type SelectionPanelProps } from "./SelectionPanel";
import type { LayoutSettingsValue } from "../sections/LayoutSettingsSection";

const defaultLayoutSettings: LayoutSettingsValue = {
  preset: "normal",
};

function renderSelectionPanel(overrides: Partial<SelectionPanelProps> = {}): ReturnType<typeof SelectionPanel> {
  const props: SelectionPanelProps = {
    counts: { containers: 1, nodes: 0 },
    showContainerSections: true,
    direction: "TB",
    onDirectionChange: () => {},
    layoutSettings: defaultLayoutSettings,
    onPreset: () => {},
    onAdvanced: () => {},
    onReset: () => {},
    showReset: false,
    onLayoutAction: () => {},
    pinValues: { size: false, position: false },
    onPinToggle: () => {},
    pending: null,
    showStyles: false,
    styleState: { dash: null, font: null, size: null },
    onStyleDash: () => {},
    onStyleFont: () => {},
    onStyleSize: () => {},
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

  test("singleContainerTitlePosition defined → ContainerTitlePositionSection rendered с подписью per-container", () => {
    const tree = renderSelectionPanel({
      showContainerSections: true,
      singleContainerTitlePosition: "inside-center",
      onSingleContainerTitlePositionChange: () => {},
    });
    const section = findComponent(tree, "ContainerTitlePositionSection");
    expect(section).not.toBeNull();
    expect(section!.props.title).toBe("Заголовок этого контейнера");
    expect(section!.props.current).toBe("inside-center");
  });

  test("singleContainerTitlePosition undefined → секция скрыта", () => {
    const tree = renderSelectionPanel({
      showContainerSections: true,
      singleContainerTitlePosition: undefined,
      onSingleContainerTitlePositionChange: undefined,
    });
    expect(hasComponent(tree, "ContainerTitlePositionSection")).toBe(false);
  });

  test("showContainerSections=false + singleContainerTitlePosition defined → секция всё равно скрыта (защита от mixed selection)", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 1 },
      showContainerSections: false,
      singleContainerTitlePosition: "outside-banner",
      onSingleContainerTitlePositionChange: () => {},
    });
    expect(hasComponent(tree, "ContainerTitlePositionSection")).toBe(false);
  });

  // DRW-186 frame-scope (extension) — single Frame показывает bulk-apply section.
  test("singleFrameContainerTitlePosition defined → ContainerTitlePositionSection с подписью frame-scope", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 0 },
      showContainerSections: true,
      singleFrameContainerTitlePosition: "inside-left",
      onSingleFrameContainerTitlePositionChange: () => {},
    });
    const section = findComponent(tree, "ContainerTitlePositionSection");
    expect(section).not.toBeNull();
    expect(section!.props.title).toBe("Заголовок контейнеров в этом фрейме");
    expect(section!.props.current).toBe("inside-left");
  });

  test("singleFrameContainerTitlePosition=inside-center (default) → секция всё равно рендерится", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 0 },
      showContainerSections: true,
      singleFrameContainerTitlePosition: "inside-center",
      onSingleFrameContainerTitlePositionChange: () => {},
    });
    const section = findComponent(tree, "ContainerTitlePositionSection");
    expect(section).not.toBeNull();
    expect(section!.props.current).toBe("inside-center");
  });

  test("singleFrame*=undefined → frame-scope секция скрыта", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 0 },
      showContainerSections: true,
      singleFrameContainerTitlePosition: undefined,
      onSingleFrameContainerTitlePositionChange: undefined,
    });
    // Если singleContainerTitlePosition тоже undefined — секция вообще не должна появиться.
    expect(hasComponent(tree, "ContainerTitlePositionSection")).toBe(false);
  });

  test("showContainerSections=false + singleFrameContainerTitlePosition defined → frame-scope секция скрыта", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 1, nodes: 1 },
      showContainerSections: false,
      singleFrameContainerTitlePosition: "outside-banner",
      onSingleFrameContainerTitlePositionChange: () => {},
    });
    expect(hasComponent(tree, "ContainerTitlePositionSection")).toBe(false);
  });

  // ---- DRW-207: тип стрелок для выделения ----

  test("showArrowKind=true → ArrowKindSection rendered (даже без контейнера в выделении)", () => {
    const tree = renderSelectionPanel({
      counts: { containers: 0, nodes: 2 },
      showContainerSections: false,
      showStyles: false,
      showArrowKind: true,
      arrowKindState: "arc",
      onStyleArrowKind: () => {},
    });
    expect(hasComponent(tree, "ArrowKindSection")).toBe(true);
  });

  test("showArrowKind=false → ArrowKindSection hidden", () => {
    const tree = renderSelectionPanel({
      showArrowKind: false,
      onStyleArrowKind: () => {},
    });
    expect(hasComponent(tree, "ArrowKindSection")).toBe(false);
  });

  test("ArrowKindSection receives arrowKindState and onStyleArrowKind", () => {
    let picked: string | null = null;
    const tree = renderSelectionPanel({
      showArrowKind: true,
      arrowKindState: "elbow",
      onStyleArrowKind: (v: "arc" | "elbow") => {
        picked = v;
      },
    });
    const section = findComponent(tree, "ArrowKindSection");
    expect(section).not.toBeNull();
    expect(section!.props.current).toBe("elbow");
    const onChange = section?.props.onChange as ((v: string) => void) | undefined;
    onChange?.("arc");
    expect(picked).toBe("arc" as never);
  });
});
