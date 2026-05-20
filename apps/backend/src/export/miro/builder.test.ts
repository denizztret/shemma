import { describe, expect, it } from "bun:test";
import {
  buildFramePayload,
  buildShapePayload,
  buildStickyNotePayload,
  buildTextPayload,
  buildConnectorPayload,
  expandGroups,
  collectArrowEndpointsFromStore,
  anchorToSnapTo,
  mapGeoToMiroShape,
} from "./builder";
import type { RawShape } from "./coords";

function makeShape(props: Partial<RawShape>): RawShape {
  return {
    id: "shape:default",
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    props: { w: 100, h: 50, geo: "rectangle" },
    ...props,
  };
}

describe("mapGeoToMiroShape", () => {
  it("rectangle → rectangle", () => {
    expect(mapGeoToMiroShape("rectangle")).toBe("rectangle");
  });
  it("ellipse → circle", () => {
    expect(mapGeoToMiroShape("ellipse")).toBe("circle");
  });
  it("diamond → rhombus", () => {
    expect(mapGeoToMiroShape("diamond")).toBe("rhombus");
  });
  it("triangle → triangle", () => {
    expect(mapGeoToMiroShape("triangle")).toBe("triangle");
  });
  it("arrow-right → right_arrow", () => {
    expect(mapGeoToMiroShape("arrow-right")).toBe("right_arrow");
  });
  it("unknown geo → rectangle (fallback)", () => {
    expect(mapGeoToMiroShape("alien-pentagram")).toBe("rectangle");
  });
});

describe("buildShapePayload — geo rectangle", () => {
  it("produces type:'shape' with mapped geo + position + geometry", () => {
    const s = makeShape({
      id: "shape:a",
      props: {
        w: 100,
        h: 50,
        geo: "rectangle",
        fill: "solid",
        color: "blue",
        richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "API" }] }] },
      },
    });
    const payload = buildShapePayload(s, {
      miroX: -50,
      miroY: -25,
    });
    expect(payload.type).toBe("shape");
    expect(payload.data?.shape).toBe("rectangle");
    expect(payload.data?.content).toBe("API");
    expect(payload.position).toEqual({ x: -50, y: -25 });
    expect(payload.geometry).toEqual({ width: 100, height: 50 });
  });

  it("when parent.id set: position is interpreted as frame-relative by caller (builder passes through)", () => {
    const s = makeShape({ id: "shape:child", parentId: "shape:frame" });
    const p = buildShapePayload(s, {
      miroX: 10,
      miroY: 10,
      parentMiroId: "miro-frame-1",
    });
    expect(p.parent?.id).toBe("miro-frame-1");
  });
});

describe("buildStickyNotePayload", () => {
  it("type:'sticky_note' + named fillColor", () => {
    const s = makeShape({
      id: "shape:n",
      type: "note",
      props: {
        w: 100,
        h: 100,
        color: "yellow",
        richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Note" }] }] },
      },
    });
    const p = buildStickyNotePayload(s, {
      miroX: 0,
      miroY: 0,
    });
    expect(p.type).toBe("sticky_note");
    expect(p.data?.content).toBe("Note");
    // style.fillColor is one of 16 sticky enum values (gray|yellow|...).
    expect(typeof p.style?.fillColor).toBe("string");
  });
});

describe("buildTextPayload", () => {
  it("type:'text' with content from richText", () => {
    const s = makeShape({
      id: "shape:t",
      type: "text",
      props: {
        w: 200,
        richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] },
      },
    });
    const p = buildTextPayload(s, {
      miroX: 0,
      miroY: 0,
    });
    expect(p.type).toBe("text");
    expect(p.data?.content).toBe("Hi");
  });
});

describe("buildFramePayload", () => {
  it("type:'frame' with title from props.name", () => {
    const s = makeShape({
      id: "shape:f",
      type: "frame",
      props: { w: 400, h: 300, name: "Boundary A" },
    });
    const p = buildFramePayload(s, {
      miroX: 0,
      miroY: 0,
    });
    expect(p.type).toBe("frame");
    expect(p.data?.title).toBe("Boundary A");
    expect(p.geometry).toEqual({ width: 400, height: 300 });
  });

  it("geo with meta.role==='boundary' is treated as frame at the caller level", () => {
    // builder is dumb: caller decides routing (frame vs shape) by checking
    // shape.type === "frame" || shape.meta?.role === "boundary".
    // This test documents that contract (no behavior to assert in builder itself).
    expect(true).toBe(true);
  });
});

describe("expandGroups", () => {
  it("group of 3 shapes: drops group, returns 3 child ids", () => {
    const store: Record<string, RawShape> = {
      "shape:g": { id: "shape:g", typeName: "shape", type: "group", parentId: "page:page" },
      "shape:c1": { id: "shape:c1", typeName: "shape", type: "geo", parentId: "shape:g" },
      "shape:c2": { id: "shape:c2", typeName: "shape", type: "geo", parentId: "shape:g" },
      "shape:c3": { id: "shape:c3", typeName: "shape", type: "geo", parentId: "shape:g" },
    };
    const out = expandGroups(["shape:g"], store);
    expect(new Set(out)).toEqual(new Set(["shape:c1", "shape:c2", "shape:c3"]));
  });

  it("non-group shapes pass through unchanged", () => {
    const store: Record<string, RawShape> = {
      "shape:x": { id: "shape:x", typeName: "shape", type: "geo" },
    };
    expect(expandGroups(["shape:x"], store)).toEqual(["shape:x"]);
  });

  it("nested groups: recursively expanded", () => {
    const store: Record<string, RawShape> = {
      "shape:outer": { id: "shape:outer", typeName: "shape", type: "group" },
      "shape:inner": { id: "shape:inner", typeName: "shape", type: "group", parentId: "shape:outer" },
      "shape:leaf": { id: "shape:leaf", typeName: "shape", type: "geo", parentId: "shape:inner" },
    };
    expect(expandGroups(["shape:outer"], store)).toEqual(["shape:leaf"]);
  });
});

describe("collectArrowEndpointsFromStore", () => {
  it("returns start + end terminals from binding records", () => {
    const store: Record<string, RawShape> = {
      "shape:arr": { id: "shape:arr", typeName: "shape", type: "arrow" },
      "binding:s": {
        id: "binding:s",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arr",
        toId: "shape:A",
        props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 } },
      } as unknown as RawShape,
      "binding:e": {
        id: "binding:e",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arr",
        toId: "shape:B",
        props: { terminal: "end", normalizedAnchor: { x: 0.9, y: 0.5 } },
      } as unknown as RawShape,
    };
    const ep = collectArrowEndpointsFromStore("shape:arr", store);
    expect(ep.start?.toId).toBe("shape:A");
    expect(ep.end?.toId).toBe("shape:B");
    expect(ep.end?.normalizedAnchor.x).toBe(0.9);
  });

  it("free-floating arrow (no bindings): returns empty", () => {
    const store: Record<string, RawShape> = {
      "shape:arr": { id: "shape:arr", typeName: "shape", type: "arrow" },
    };
    const ep = collectArrowEndpointsFromStore("shape:arr", store);
    expect(ep.start).toBeUndefined();
    expect(ep.end).toBeUndefined();
  });
});

describe("anchorToSnapTo (thresholds 0.25 / 0.75)", () => {
  it("y < 0.25 → 'top'", () => {
    expect(anchorToSnapTo({ x: 0.5, y: 0.1 })).toBe("top");
  });
  it("y > 0.75 → 'bottom'", () => {
    expect(anchorToSnapTo({ x: 0.5, y: 0.9 })).toBe("bottom");
  });
  it("x < 0.25 → 'left'", () => {
    expect(anchorToSnapTo({ x: 0.1, y: 0.5 })).toBe("left");
  });
  it("x > 0.75 → 'right'", () => {
    expect(anchorToSnapTo({ x: 0.9, y: 0.5 })).toBe("right");
  });
  it("center → 'auto'", () => {
    expect(anchorToSnapTo({ x: 0.5, y: 0.5 })).toBe("auto");
  });
  it("y === 0.25 boundary → 'auto' (strict <, not <=)", () => {
    expect(anchorToSnapTo({ x: 0.5, y: 0.25 })).toBe("auto");
  });
  it("y === 0.75 boundary → 'auto'", () => {
    expect(anchorToSnapTo({ x: 0.5, y: 0.75 })).toBe("auto");
  });
});

describe("buildConnectorPayload", () => {
  it("resolves startItem.id and endItem.id from passAMap; sets snapTo", () => {
    const arrow: RawShape = {
      id: "shape:arr",
      typeName: "shape",
      type: "arrow",
      props: { bend: 0 },
    };
    const store: Record<string, RawShape> = {
      [arrow.id]: arrow,
      "binding:s": {
        id: "binding:s",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arr",
        toId: "shape:A",
        props: { terminal: "start", normalizedAnchor: { x: 0.9, y: 0.5 } },
      } as unknown as RawShape,
      "binding:e": {
        id: "binding:e",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arr",
        toId: "shape:B",
        props: { terminal: "end", normalizedAnchor: { x: 0.1, y: 0.5 } },
      } as unknown as RawShape,
    };
    const passAMap = new Map<string, string>([
      ["shape:A", "miro-A"],
      ["shape:B", "miro-B"],
    ]);
    const result = buildConnectorPayload(arrow, {
      store,
      passAMap,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.payload.startItem.id).toBe("miro-A");
      expect(result.payload.startItem.snapTo).toBe("right");
      expect(result.payload.endItem.id).toBe("miro-B");
      expect(result.payload.endItem.snapTo).toBe("left");
    }
  });

  it("free-floating arrow: returns skip with reason='unsupported-type'", () => {
    const arrow: RawShape = { id: "shape:arr", typeName: "shape", type: "arrow" };
    const result = buildConnectorPayload(arrow, {
      store: { [arrow.id]: arrow },
      passAMap: new Map(),
    });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.reason).toBe("unsupported-type");
    }
  });

  it("cross-selection: endpoint not in passAMap → skip with reason", () => {
    const arrow: RawShape = { id: "shape:arr", typeName: "shape", type: "arrow" };
    const store: Record<string, RawShape> = {
      [arrow.id]: arrow,
      "binding:s": {
        id: "binding:s", typeName: "binding", type: "arrow", fromId: "shape:arr", toId: "shape:A",
        props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 } },
      } as unknown as RawShape,
      "binding:e": {
        id: "binding:e", typeName: "binding", type: "arrow", fromId: "shape:arr", toId: "shape:C",
        props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 } },
      } as unknown as RawShape,
    };
    // passAMap has only shape:A — shape:C is outside selection
    const passAMap = new Map([["shape:A", "miro-A"]]);
    const result = buildConnectorPayload(arrow, {
      store, passAMap,
    });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.reason).toBe("cross-selection-connector");
    }
  });
});
