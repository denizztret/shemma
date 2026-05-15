import { describe, expect, test } from "bun:test";
import { isValidName } from "../src/validation";

describe("isValidName", () => {
  test.each(["auth", "users-db", "vpc_prod", "a", "x".repeat(64)])(
    "accepts %s", (n) => { expect(isValidName(n)).toBe(true); },
  );
  test.each(["", "with space", "ALL-CAPS", "with.dot", "x".repeat(65), "имя"])(
    "rejects %s", (n) => { expect(isValidName(n)).toBe(false); },
  );
});
