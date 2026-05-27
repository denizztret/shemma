import { describe, expect, test } from "bun:test";
import { selectionFooterCounter, selectionHasContainer } from "./SelectionPanel";

describe("selectionFooterCounter", () => {
  test("1 container only", () => {
    expect(selectionFooterCounter({ containers: 1, nodes: 0 })).toBe("1 container");
  });
  test("2 containers + 5 nodes", () => {
    expect(selectionFooterCounter({ containers: 2, nodes: 5 })).toBe("2 containers, 5 nodes");
  });
  test("7 nodes only", () => {
    expect(selectionFooterCounter({ containers: 0, nodes: 7 })).toBe("7 shapes");
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
