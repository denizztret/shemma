import { describe, it, expect } from "bun:test";
import { parseShemmaUrl, spaceUrl } from "../url-parser";

describe("parseShemmaUrl", () => {
  it("returns landing when no params", () => {
    expect(parseShemmaUrl("/")).toEqual({ view: "landing" });
  });
  it("returns landing when only unrelated params", () => {
    expect(parseShemmaUrl("/?other=1")).toEqual({ view: "landing" });
  });
  it("parses ?space=A as gallery view", () => {
    expect(parseShemmaUrl("/?space=A")).toEqual({
      view: "gallery",
      spaceId: "A",
    });
  });
  it("parses ?space=A&room=R as room view", () => {
    expect(parseShemmaUrl("/?space=A&room=R")).toEqual({
      view: "room",
      spaceId: "A",
      roomId: "R",
    });
  });
  it("decodes URL-encoded space + room", () => {
    expect(parseShemmaUrl("/?space=my%20space&room=my%2Froom")).toEqual({
      view: "room",
      spaceId: "my space",
      roomId: "my/room",
    });
  });
});

describe("spaceUrl", () => {
  it("builds gallery URL", () => {
    expect(spaceUrl("A")).toBe("/?space=A");
  });
  it("builds room URL", () => {
    expect(spaceUrl("A", "R")).toBe("/?space=A&room=R");
  });
  it("encodes spaceId and roomId", () => {
    expect(spaceUrl("my space", "my/room")).toBe(
      "/?space=my%20space&room=my%2Froom",
    );
  });
});
