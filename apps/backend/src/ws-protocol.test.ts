import { describe, expect, it } from "bun:test";
import { parseClientMessage } from "./ws-protocol";

describe("parseClientMessage — board-focus", () => {
  it("parses valid {kind:'board-focus', room:'x', focused:true}", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "x", focused: true }),
    );
    expect(result).toEqual({ kind: "board-focus", room: "x", focused: true });
  });

  it("parses valid {kind:'board-focus', room:'x', focused:false}", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "x", focused: false }),
    );
    expect(result).toEqual({ kind: "board-focus", room: "x", focused: false });
  });

  it("returns null when room is empty string", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "", focused: true }),
    );
    expect(result).toBeNull();
  });

  it("returns null when focused is not boolean", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "x", focused: 1 }),
    );
    expect(result).toBeNull();
  });

  it("returns null when kind is unknown (existing behavior)", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "unknown-kind", foo: "bar" }),
    );
    expect(result).toBeNull();
  });
});
