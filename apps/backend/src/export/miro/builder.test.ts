import { describe, expect, it } from "bun:test";
import {
  buildShapeForFrame,
  buildShapePayload,
  buildStickyNotePayload,
  buildTextPayload,
  buildConnectorPayload,
  expandGroups,
  collectArrowEndpointsFromStore,
  anchorToSnapTo,
  mapGeoToMiroShape,
  tldrawSizeToFontSize,
  tldrawSizeToBorderWidth,
  tldrawSizeToStrokeWidth,
  tldrawSizeToStickyFontSize,
  tldrawFontToFamily,
  tldrawArrowheadToStrokeCap,
  fillStyle,
} from "./builder";
import { tldrawNamedToHex } from "./color-mapping";
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

// ---------------------------------------------------------------------------
// Task 2: size mapping helpers
// ---------------------------------------------------------------------------

describe("tldrawSizeToFontSize", () => {
  it("s → '12'", () => expect(tldrawSizeToFontSize("s")).toBe("12"));
  it("m → '14'", () => expect(tldrawSizeToFontSize("m")).toBe("14"));
  it("l → '20'", () => expect(tldrawSizeToFontSize("l")).toBe("20"));
  it("xl → '30'", () => expect(tldrawSizeToFontSize("xl")).toBe("30"));
  it("undefined → '14' (default = m)", () => expect(tldrawSizeToFontSize(undefined)).toBe("14"));
  it("unknown → '14' (fallback = m)", () => expect(tldrawSizeToFontSize("xxl")).toBe("14"));
});

describe("tldrawSizeToBorderWidth", () => {
  it("s → '1.0'", () => expect(tldrawSizeToBorderWidth("s")).toBe("1.0"));
  it("m → '2.0'", () => expect(tldrawSizeToBorderWidth("m")).toBe("2.0"));
  it("l → '3.0'", () => expect(tldrawSizeToBorderWidth("l")).toBe("3.0"));
  it("xl → '4.0'", () => expect(tldrawSizeToBorderWidth("xl")).toBe("4.0"));
  it("undefined → '2.0' (default = m)", () => expect(tldrawSizeToBorderWidth(undefined)).toBe("2.0"));
});

describe("tldrawSizeToStrokeWidth", () => {
  it("mirrors tldrawSizeToBorderWidth for all sizes", () => {
    for (const s of ["s", "m", "l", "xl", undefined] as const) {
      expect(tldrawSizeToStrokeWidth(s)).toBe(tldrawSizeToBorderWidth(s));
    }
  });
  it("s → '1.0'", () => expect(tldrawSizeToStrokeWidth("s")).toBe("1.0"));
  it("xl → '4.0'", () => expect(tldrawSizeToStrokeWidth("xl")).toBe("4.0"));
});

describe("tldrawSizeToStickyFontSize", () => {
  it("s → '14'", () => expect(tldrawSizeToStickyFontSize("s")).toBe("14"));
  it("m → '24'", () => expect(tldrawSizeToStickyFontSize("m")).toBe("24"));
  it("l → '36'", () => expect(tldrawSizeToStickyFontSize("l")).toBe("36"));
  it("xl → '48'", () => expect(tldrawSizeToStickyFontSize("xl")).toBe("48"));
  it("undefined → '24' (default = m)", () => expect(tldrawSizeToStickyFontSize(undefined)).toBe("24"));
});

// ---------------------------------------------------------------------------
// Task 3: font mapping helper
// ---------------------------------------------------------------------------

describe("tldrawFontToFamily", () => {
  it("draw → 'caveat'", () => expect(tldrawFontToFamily("draw")).toBe("caveat"));
  it("sans → 'open_sans'", () => expect(tldrawFontToFamily("sans")).toBe("open_sans"));
  it("serif → 'times_new_roman'", () => expect(tldrawFontToFamily("serif")).toBe("times_new_roman"));
  it("mono → 'roboto_mono'", () => expect(tldrawFontToFamily("mono")).toBe("roboto_mono"));
  it("undefined → 'open_sans'", () => expect(tldrawFontToFamily(undefined)).toBe("open_sans"));
  it("unknown string → 'open_sans'", () => expect(tldrawFontToFamily("comic-sans")).toBe("open_sans"));
});

// ---------------------------------------------------------------------------
// Task 4: arrowhead mapping helper
// ---------------------------------------------------------------------------

describe("tldrawArrowheadToStrokeCap", () => {
  it("none → 'none'", () => expect(tldrawArrowheadToStrokeCap("none")).toBe("none"));
  it("triangle → 'filled_triangle'", () => expect(tldrawArrowheadToStrokeCap("triangle")).toBe("filled_triangle"));
  it("square → 'none' (degrade, no rectangular cap in Miro)", () => expect(tldrawArrowheadToStrokeCap("square")).toBe("none"));
  it("dot → 'filled_oval'", () => expect(tldrawArrowheadToStrokeCap("dot")).toBe("filled_oval"));
  it("diamond → 'filled_diamond'", () => expect(tldrawArrowheadToStrokeCap("diamond")).toBe("filled_diamond"));
  it("inverted → 'arrow' (degrade, no backward cap in Miro)", () => expect(tldrawArrowheadToStrokeCap("inverted")).toBe("arrow"));
  it("bar → 'none' (degrade)", () => expect(tldrawArrowheadToStrokeCap("bar")).toBe("none"));
  it("pipe → 'none' (degrade)", () => expect(tldrawArrowheadToStrokeCap("pipe")).toBe("none"));
  it("arrow → 'arrow'", () => expect(tldrawArrowheadToStrokeCap("arrow")).toBe("arrow"));
  it("undefined → 'arrow' (default)", () => expect(tldrawArrowheadToStrokeCap(undefined)).toBe("arrow"));
});

// ---------------------------------------------------------------------------
// Task 5: fillStyle helper
// ---------------------------------------------------------------------------

describe("fillStyle", () => {
  const hex = "#4465e9";
  it("solid → fillColor set + fillOpacity '1.0'", () => {
    const r = fillStyle("solid", hex);
    expect(r.fillColor).toBe(hex);
    expect(r.fillOpacity).toBe("1.0");
  });
  it("semi → fillColor set + fillOpacity '0.5'", () => {
    const r = fillStyle("semi", hex);
    expect(r.fillColor).toBe(hex);
    expect(r.fillOpacity).toBe("0.5");
  });
  it("pattern → fillColor set + fillOpacity '0.5' (degrade to semi, Miro no diag-fill)", () => {
    const r = fillStyle("pattern", hex);
    expect(r.fillColor).toBe(hex);
    expect(r.fillOpacity).toBe("0.5");
  });
  it("none → no fillColor + fillOpacity '0.0'", () => {
    const r = fillStyle("none", hex);
    expect(r.fillColor).toBeUndefined();
    expect(r.fillOpacity).toBe("0.0");
  });
  it("undefined → no fillColor + fillOpacity '0.0'", () => {
    const r = fillStyle(undefined, hex);
    expect(r.fillColor).toBeUndefined();
    expect(r.fillOpacity).toBe("0.0");
  });
});

// ---------------------------------------------------------------------------
// Task 6: buildShapePayload styling (DRW-111)
// ---------------------------------------------------------------------------

describe("buildShapePayload styling (DRW-111)", () => {
  it("color:red size:l font:mono fill:solid → full styling applied", () => {
    const s = makeShape({
      id: "shape:r1",
      props: {
        w: 120,
        h: 80,
        geo: "rectangle",
        color: "red",
        size: "l",
        font: "mono",
        fill: "solid",
        align: "middle",
        verticalAlign: "middle",
      },
    });
    const p = buildShapePayload(s, { miroX: 0, miroY: 0 });
    const style = p.style as Record<string, unknown>;
    const colorHex = tldrawNamedToHex("red");
    expect(style.borderColor).toBe(colorHex);
    expect(style.fillColor).toBe(colorHex);
    expect(style.fillOpacity).toBe("1.0");
    expect(style.borderWidth).toBe("3.0");
    expect(style.fontSize).toBe("20");
    expect(style.fontFamily).toBe("roboto_mono");
  });

  it("color:blue fill:none → fillOpacity '0.0', no fillColor", () => {
    const s = makeShape({
      id: "shape:r2",
      props: {
        w: 100,
        h: 60,
        geo: "ellipse",
        color: "blue",
        fill: "none",
      },
    });
    const p = buildShapePayload(s, { miroX: 0, miroY: 0 });
    const style = p.style as Record<string, unknown>;
    expect(style.fillOpacity).toBe("0.0");
    expect(style.fillColor).toBeUndefined();
  });

  it("meta.fillHex override preserved over props-derived hex", () => {
    const s = makeShape({
      id: "shape:r3",
      props: { w: 100, h: 50, geo: "rectangle", color: "red", fill: "solid" },
      meta: { fillHex: "#aabbcc" },
    });
    const p = buildShapePayload(s, { miroX: 0, miroY: 0 });
    const style = p.style as Record<string, unknown>;
    expect(style.fillColor).toBe("#aabbcc");
  });

  it("meta.borderHex override preserved", () => {
    const s = makeShape({
      id: "shape:r4",
      props: { w: 100, h: 50, geo: "rectangle", color: "red" },
      meta: { borderHex: "#112233" },
    });
    const p = buildShapePayload(s, { miroX: 0, miroY: 0 });
    const style = p.style as Record<string, unknown>;
    expect(style.borderColor).toBe("#112233");
  });
});

// ---------------------------------------------------------------------------
// Task 7: buildConnectorPayload styling (DRW-111)
// ---------------------------------------------------------------------------

describe("buildConnectorPayload styling (DRW-111)", () => {
  it("color/size/font/arrowhead applied", () => {
    const arrow: RawShape = {
      id: "shape:arr2",
      typeName: "shape",
      type: "arrow",
      props: {
        bend: 0,
        color: "green",
        size: "xl",
        font: "sans",
        arrowheadStart: "diamond",
        arrowheadEnd: "triangle",
        dash: "solid",
      },
    };
    const store: Record<string, RawShape> = {
      [arrow.id]: arrow,
      "binding:s2": {
        id: "binding:s2",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arr2",
        toId: "shape:X",
        props: { terminal: "start", normalizedAnchor: { x: 0.9, y: 0.5 } },
      } as unknown as RawShape,
      "binding:e2": {
        id: "binding:e2",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arr2",
        toId: "shape:Y",
        props: { terminal: "end", normalizedAnchor: { x: 0.1, y: 0.5 } },
      } as unknown as RawShape,
    };
    const passAMap = new Map<string, string>([
      ["shape:X", "miro-X"],
      ["shape:Y", "miro-Y"],
    ]);
    const result = buildConnectorPayload(arrow, { store, passAMap });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      const style = result.payload.style as Record<string, unknown>;
      expect(style.strokeColor).toBe(tldrawNamedToHex("green"));
      expect(style.strokeWidth).toBe("4.0");
      expect(style.startStrokeCap).toBe("filled_diamond");
      expect(style.endStrokeCap).toBe("filled_triangle");
      // fontFamily + fontSize are NOT supported on Miro connectors (returns 400 code 2.0703)
      expect(style.fontFamily).toBeUndefined();
      expect(style.fontSize).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 8: buildStickyNotePayload styling (DRW-111)
// ---------------------------------------------------------------------------

describe("buildStickyNotePayload styling (DRW-111)", () => {
  it("color:yellow size:l font:serif → fillColor, fontFamily, fontSize", () => {
    const s = makeShape({
      id: "shape:sn1",
      type: "note",
      props: { w: 200, h: 200, color: "yellow", size: "l", font: "serif" },
    });
    const p = buildStickyNotePayload(s, { miroX: 0, miroY: 0 });
    const style = p.style as Record<string, unknown>;
    expect(typeof style.fillColor).toBe("string");
    expect((style.fillColor as string).length).toBeGreaterThan(0);
    expect(style.fontFamily).toBe("times_new_roman");
    expect(style.fontSize).toBe("36");
  });

  it("no props → fillColor 'yellow' fallback", () => {
    const s = makeShape({
      id: "shape:sn2",
      type: "note",
      props: {},
    });
    const p = buildStickyNotePayload(s, { miroX: 0, miroY: 0 });
    const style = p.style as Record<string, unknown>;
    expect(style.fillColor).toBe("yellow");
  });
});

// ---------------------------------------------------------------------------
// Task 9: buildTextPayload styling (DRW-111)
// ---------------------------------------------------------------------------

describe("buildTextPayload styling (DRW-111)", () => {
  it("color + fontFamily + fontSize + textAlign applied", () => {
    const text = makeShape({
      id: "shape:t1",
      type: "text",
      props: { color: "red", size: "m", font: "mono", textAlign: "start", w: 100 },
    });
    const r = buildTextPayload(text, { miroX: 0, miroY: 0 });
    const style = r.style as Record<string, unknown>;
    expect(style.color).toBe(tldrawNamedToHex("red"));
    expect(style.fontFamily).toBe("roboto_mono");
    expect(style.fontSize).toBe("14");
    expect(style.textAlign).toBe("left"); // tldraw "start" → Miro "left"
  });
});

// ---------------------------------------------------------------------------
// Task 10: buildShapeForFrame helper (DRW-111 Block 5)
// ---------------------------------------------------------------------------

describe("buildShapeForFrame (DRW-111 Block 5)", () => {
  it("returns rectangle with white fill + tldraw border color + title", () => {
    const frame = { typeName: "shape", type: "frame", id: "shape:F1",
      props: { name: "Backend", color: "blue", size: "m", w: 400, h: 300 } };
    const r = buildShapeForFrame(frame as never, { miroX: 100, miroY: 100 });
    expect(r.type).toBe("shape");
    expect((r.data as any)?.shape).toBe("rectangle");
    expect((r.data as any)?.content).toBe("Backend");
    expect((r.style as any)?.fillColor).toBe("#ffffff");
    expect((r.style as any)?.fillOpacity).toBe("1.0");
    expect((r.style as any)?.borderStyle).toBe("normal");
    expect((r.style as any)?.borderColor).toBe(tldrawNamedToHex("blue"));
    expect((r.style as any)?.borderWidth).toBe("2.0");
    expect((r.style as any)?.textAlign).toBe("center");
    expect((r.style as any)?.textAlignVertical).toBe("top");
  });

  it("frame без color → black border", () => {
    const frame = { typeName: "shape", type: "frame", id: "shape:F2",
      props: { name: "Default", w: 200, h: 200 } };
    const r = buildShapeForFrame(frame as never, { miroX: 0, miroY: 0 });
    expect((r.style as any)?.borderColor).toBe(tldrawNamedToHex("black"));
  });

  it("frame falls back to meta.didrawName when props.name absent", () => {
    const frame = { typeName: "shape", type: "frame", id: "shape:F3",
      props: { w: 100, h: 100 }, meta: { didrawName: "fallback-name" } };
    const r = buildShapeForFrame(frame as never, { miroX: 0, miroY: 0 });
    expect((r.data as any)?.content).toBe("fallback-name");
  });
});
