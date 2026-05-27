import { describe, expect, test } from "bun:test";
import { selectionFooterCounter, selectionHasContainer } from "./SelectionPanel";

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

describe("BoardPanel", () => {
  test("exports a component", () => {
    expect(typeof BoardPanel).toBe("function");
  });
});

import { BoardPanelAdvanced } from "./BoardPanelAdvanced";

describe("BoardPanelAdvanced", () => {
  test("exports a component", () => {
    expect(typeof BoardPanelAdvanced).toBe("function");
  });
});
