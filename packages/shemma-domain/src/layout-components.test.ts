import { describe, expect, it } from "bun:test";
import {
  type ComponentInfo,
  buildComponentGraphs,
  packComponents,
  partitionComponents,
  rankComponents,
  splitStrays,
} from "./layout-components";

describe("partitionComponents", () => {
  it("splits a graph into connected components by collapsed edges", () => {
    const comps = partitionComponents(
      ["a", "b", "c", "d", "e"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "d", to: "e" },
      ],
    );
    expect(comps).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  it("keeps isolated nodes as singleton components", () => {
    const comps = partitionComponents(["a", "b"], []);
    expect(comps).toEqual([["a"], ["b"]]);
  });

  it("ignores edges with endpoints outside the id set (cross-frame)", () => {
    const comps = partitionComponents(["a", "b"], [{ from: "a", to: "ghost" }]);
    expect(comps).toEqual([["a"], ["b"]]);
  });

  it("is deterministic: same input → same output, ids keep input order", () => {
    const ids = ["n3", "n1", "n2"];
    const edges = [{ from: "n2", to: "n3" }];
    const first = partitionComponents(ids, edges);
    expect(partitionComponents(ids, edges)).toEqual(first);
    expect(first).toEqual([["n3", "n2"], ["n1"]]);
  });

  it("empty input → empty component list", () => {
    expect(partitionComponents([], [])).toEqual([]);
  });
});

describe("rankComponents", () => {
  const info = {
    boxA: { leaves: 4, area: 1000 },
    boxB: { leaves: 4, area: 2000 },
    geo1: { leaves: 1, area: 100 },
    geo2: { leaves: 1, area: 100 },
  };

  it("main component = most leaves", () => {
    const ranked = rankComponents([["geo1"], ["boxA", "geo2"]], info);
    expect(ranked[0]?.ids).toEqual(["boxA", "geo2"]);
    expect(ranked[0]?.leaves).toBe(5);
  });

  it("tie-break by total area, then by first id (lexicographic)", () => {
    const byArea = rankComponents([["boxA"], ["boxB"]], info);
    expect(byArea[0]?.ids).toEqual(["boxB"]); // 2000 > 1000
    const byId = rankComponents([["geo2"], ["geo1"]], info);
    expect(byId[0]?.ids).toEqual(["geo1"]); // equal leaves+area → min id
  });

  it("repeated call returns identical order (determinism)", () => {
    const comps = [["geo1"], ["boxB"], ["boxA"], ["geo2"]];
    const a = rankComponents(comps, info);
    const b = rankComponents(comps, info);
    expect(a.map((c: ComponentInfo) => c.ids)).toEqual(
      b.map((c: ComponentInfo) => c.ids),
    );
  });
});

describe("splitStrays", () => {
  const ci = (ids: string[]): ComponentInfo => ({ ids, leaves: 0, area: 0 });
  const isGeo = (id: string) => id.startsWith("geo");

  it("collects singleton GEO components into strays, keeps the rest", () => {
    const { real, strays } = splitStrays(
      [ci(["boxA", "geo9"]), ci(["geo1"]), ci(["boxB"]), ci(["geo2"])],
      isGeo,
    );
    expect(real.map((c) => c.ids)).toEqual([["boxA", "geo9"], ["boxB"]]);
    expect(strays).toEqual(["geo1", "geo2"]);
  });

  it("a lone container is a REAL component, not a stray", () => {
    const { real, strays } = splitStrays([ci(["boxA"])], isGeo);
    expect(real.map((c) => c.ids)).toEqual([["boxA"]]);
    expect(strays).toEqual([]);
  });

  it("no components → empty real and strays", () => {
    expect(splitStrays([], isGeo)).toEqual({ real: [], strays: [] });
  });
});

describe("packComponents", () => {
  const boxes = [
    { w: 400, h: 300 }, // main
    { w: 100, h: 80 },
    { w: 120, h: 50 },
  ];

  it("TB frame: secondaries stack in a column to the RIGHT of the main", () => {
    const off = packComponents(boxes, "TB", 20);
    expect(off).toEqual([
      { dx: 0, dy: 0 },
      { dx: 420, dy: 0 }, // main.w + gap
      { dx: 420, dy: 100 }, // prev.h + gap accumulated
    ]);
  });

  it("LR frame: secondaries stack in a row BELOW the main", () => {
    const off = packComponents(boxes, "LR", 20);
    expect(off).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 320 }, // main.h + gap
      { dx: 120, dy: 320 }, // prev.w + gap accumulated
    ]);
  });

  it("BT behaves like TB, RL like LR (same cross axis)", () => {
    expect(packComponents(boxes, "BT", 20)).toEqual(
      packComponents(boxes, "TB", 20),
    );
    expect(packComponents(boxes, "RL", 20)).toEqual(
      packComponents(boxes, "LR", 20),
    );
  });

  it("single component → only the zero offset", () => {
    expect(packComponents([{ w: 10, h: 10 }], "TB", 20)).toEqual([
      { dx: 0, dy: 0 },
    ]);
  });

  it("no components → no offsets", () => {
    expect(packComponents([], "TB", 20)).toEqual([]);
  });
});

describe("buildComponentGraphs", () => {
  it("routes each root edge into its owning component's graph", () => {
    const comps: ComponentInfo[] = [
      { ids: ["a", "b"], leaves: 2, area: 0 },
      { ids: ["c", "d"], leaves: 2, area: 0 },
    ];
    const graphs = buildComponentGraphs(comps, [
      { id: "a>b", sources: ["a"], targets: ["b"] },
      { id: "c>d", sources: ["c"], targets: ["d"] },
    ]);
    const g0 = graphs[0];
    const g1 = graphs[1];
    if (!g0 || !g1) throw new Error("Expected two component graphs");
    expect(g0.ids).toEqual(["a", "b"]);
    expect(g0.edges.map((e) => e.id)).toEqual(["a>b"]);
    expect(g1.edges.map((e) => e.id)).toEqual(["c>d"]);
  });
});
