import { describe, it, expect } from "bun:test";
import { parseShemmaUrl, serializeColumns } from "../url-parser";
import { applyOpenRoom, applyBackToGallery } from "../column-transitions";

describe("URL state roundtrip", () => {
  it("parseShemmaUrl → applyOpenRoom → serializeColumns", () => {
    const parsed = parseShemmaUrl("/?cols=A,B");
    expect(parsed.view).toBe("columns");
    if (parsed.view !== "columns") return;
    const next = applyOpenRoom(parsed.columns, 1, "foo");
    const serialized = serializeColumns(next);
    // Re-parse and check
    const reparsed = parseShemmaUrl(`/${serialized}`);
    expect(reparsed).toEqual({
      view: "columns",
      columns: [
        { kind: "gallery", spaceId: "A" },
        { kind: "room", spaceId: "B", roomId: "foo" },
      ],
    });
  });

  it("opening then closing returns to original", () => {
    const parsed = parseShemmaUrl("/?cols=A,B");
    if (parsed.view !== "columns") throw new Error("bad parse");
    const opened = applyOpenRoom(parsed.columns, 1, "foo");
    const closed = applyBackToGallery(opened, 1);
    expect(closed).toEqual(parsed.columns);
  });
});
