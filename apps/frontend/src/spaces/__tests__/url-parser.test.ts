import { describe, it, expect } from "bun:test";
import { parseShemmaUrl, serializeColumns } from "../url-parser";

describe("parseShemmaUrl", () => {
  it("returns landing when no params", () => {
    expect(parseShemmaUrl("/")).toEqual({ view: "landing" });
  });
  it("parses ?space=A as single gallery column", () => {
    expect(parseShemmaUrl("/?space=A")).toEqual({
      view: "columns",
      columns: [{ kind: "gallery", spaceId: "A" }],
    });
  });
  it("parses ?space=A&room=R as single room column", () => {
    expect(parseShemmaUrl("/?space=A&room=R")).toEqual({
      view: "columns",
      columns: [{ kind: "room", spaceId: "A", roomId: "R" }],
    });
  });
  it("parses ?cols=A,B:r2,C", () => {
    expect(parseShemmaUrl("/?cols=A,B:r2,C")).toEqual({
      view: "columns",
      columns: [
        { kind: "gallery", spaceId: "A" },
        { kind: "room", spaceId: "B", roomId: "r2" },
        { kind: "gallery", spaceId: "C" },
      ],
    });
  });
  it("caps columns to 3", () => {
    const parsed = parseShemmaUrl("/?cols=A,B,C,D");
    expect(parsed.view).toBe("columns");
    expect((parsed as any).columns).toHaveLength(3);
  });
});

describe("serializeColumns", () => {
  it("single gallery → ?space=A", () => {
    expect(serializeColumns([{ kind: "gallery", spaceId: "A" }])).toBe("?space=A");
  });
  it("multi → ?cols=A,B:r2", () => {
    expect(serializeColumns([
      { kind: "gallery", spaceId: "A" },
      { kind: "room", spaceId: "B", roomId: "r2" },
    ])).toBe("?cols=A,B%3Ar2");
  });
});
