import { describe, expect, test } from "bun:test";
import { validateRoomId } from "./validate";

describe("validateRoomId", () => {
  test("accepts simple lowercase id", () => {
    expect(validateRoomId("default")).toBe(true);
  });

  test("accepts uppercase", () => {
    expect(validateRoomId("MyRoom")).toBe(true);
  });

  test("accepts digits", () => {
    expect(validateRoomId("room123")).toBe(true);
  });

  test("accepts hyphens", () => {
    expect(validateRoomId("my-room-id")).toBe(true);
  });

  test("accepts underscores", () => {
    expect(validateRoomId("my_room")).toBe(true);
  });

  test("accepts 64 chars", () => {
    expect(validateRoomId("a".repeat(64))).toBe(true);
  });

  test("rejects empty string", () => {
    expect(validateRoomId("")).toBe(false);
  });

  test("rejects 65 chars", () => {
    expect(validateRoomId("a".repeat(65))).toBe(false);
  });

  test("rejects spaces", () => {
    expect(validateRoomId("my room")).toBe(false);
  });

  test("rejects dots", () => {
    expect(validateRoomId("my.room")).toBe(false);
  });

  test("rejects slashes", () => {
    expect(validateRoomId("../etc/passwd")).toBe(false);
  });

  test("rejects bang", () => {
    expect(validateRoomId("room!")).toBe(false);
  });

  test("accepts mixed chars", () => {
    expect(validateRoomId("Session-2024_v1")).toBe(true);
  });

  test("accepts single char", () => {
    expect(validateRoomId("a")).toBe(true);
  });
});
