import { describe, expect, test } from "bun:test";
import { renderThumbnail } from "../src/thumbnail";

// Known store fixture: 1 geo rectangle + 1 arrow + 1 note
const knownStore = {
  store: {
    "shape:rect1": {
      typeName: "shape",
      type: "geo",
      x: 50,
      y: 50,
      props: { w: 200, h: 100, geo: "rectangle" },
    },
    "shape:arrow1": {
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      props: { w: 50, h: 50, start: { x: 10, y: 10 }, end: { x: 60, y: 60 } },
    },
    "shape:note1": {
      typeName: "shape",
      type: "note",
      x: 300,
      y: 100,
      props: { w: 100, h: 100 },
    },
    // Non-shape records should be ignored
    "page:page": { typeName: "page", id: "page:page" },
  },
};

describe("renderThumbnail", () => {
  test("empty store returns SVG with 'Empty' text", () => {
    const svg = renderThumbnail({}, 240, 160);
    expect(svg).toContain("<svg");
    expect(svg).toContain("Empty");
    expect(svg).toContain("</svg>");
  });

  test("known store: SVG structural elements present", () => {
    const svg = renderThumbnail(knownStore, 240, 160);
    // Root SVG element with viewBox
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="');
    expect(svg).toContain('width="240"');
    expect(svg).toContain('height="160"');

    // geo/rectangle → <rect>
    expect(svg).toContain("<rect");

    // arrow → <line>
    expect(svg).toContain("<line");

    // note → <rect> with fill="#fff9c4"
    expect(svg).toContain('fill="#fff9c4"');
  });

  test("non-shape records are ignored (no crashes)", () => {
    const svg = renderThumbnail(knownStore, 240, 160);
    // Should not contain 'page' element references
    expect(svg).not.toContain("typeName");
  });

  test("geo=ellipse renders <ellipse>", () => {
    const store = {
      store: {
        "shape:e1": {
          typeName: "shape",
          type: "geo",
          x: 0,
          y: 0,
          props: { w: 100, h: 80, geo: "ellipse" },
        },
      },
    };
    const svg = renderThumbnail(store, 240, 160);
    expect(svg).toContain("<ellipse");
  });

  test("geo=diamond renders <polygon>", () => {
    const store = {
      store: {
        "shape:d1": {
          typeName: "shape",
          type: "geo",
          x: 0,
          y: 0,
          props: { w: 100, h: 80, geo: "diamond" },
        },
      },
    };
    const svg = renderThumbnail(store, 240, 160);
    expect(svg).toContain("<polygon");
  });

  test("frame renders <rect> with stroke-dasharray", () => {
    const store = {
      store: {
        "shape:f1": {
          typeName: "shape",
          type: "frame",
          x: 0,
          y: 0,
          props: { w: 200, h: 150 },
        },
      },
    };
    const svg = renderThumbnail(store, 240, 160);
    expect(svg).toContain('stroke-dasharray="4 4"');
  });
});
