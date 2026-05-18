import { describe, expect, it } from "bun:test";
import { mapHttpResponse, mapFetchError, toolResult } from "./errors";

describe("error mapping", () => {
  it("422 → validation-error", () => {
    const e = mapHttpResponse(422, { errors: [{ actionIndex: 0 }] });
    expect(e.code).toBe("validation-error");
    expect(e.details).toEqual({ errors: [{ actionIndex: 0 }] });
  });
  it("409 → domain-error", () => {
    expect(mapHttpResponse(409, {}).code).toBe("domain-error");
  });
  it("500 → unexpected-error", () => {
    expect(mapHttpResponse(503, {}).code).toBe("unexpected-error");
  });
  it("network failure → daemon-unavailable", () => {
    expect(mapFetchError(new Error("ECONNREFUSED")).code).toBe("daemon-unavailable");
  });
  it("toolResult wraps success", () => {
    const r = toolResult({ ok: true, data: { hello: "world" } });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ ok: true, data: { hello: "world" } });
  });
  it("toolResult wraps error with isError:true", () => {
    const r = toolResult({ ok: false, code: "http-error", message: "x" });
    expect(r.isError).toBe(true);
  });
});
