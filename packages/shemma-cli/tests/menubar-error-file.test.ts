import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearMenubarError,
  menubarErrorPath,
  readMenubarError,
  writeMenubarError,
} from "../src/menubar/error-file";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-err-"));
  file = path.join(tmp, ".shemma-menubar-error");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("menubar error file", () => {
  test("read без файла — null", () => {
    expect(readMenubarError(file)).toBeNull();
  });

  test("write → read возвращает сообщение", () => {
    writeMenubarError("Старт демона упал: boom", file);
    expect(readMenubarError(file)).toBe("Старт демона упал: boom");
  });

  test("clear удаляет; повторный clear не бросает", () => {
    writeMenubarError("x", file);
    clearMenubarError(file);
    expect(readMenubarError(file)).toBeNull();
    clearMenubarError(file); // идемпотентно
  });

  test("пустой файл читается как null", () => {
    fs.writeFileSync(file, "  \n");
    expect(readMenubarError(file)).toBeNull();
  });

  test("дефолтный путь — ~/.claude/.shemma-menubar-error", () => {
    expect(menubarErrorPath()).toBe(
      path.join(os.homedir(), ".claude", ".shemma-menubar-error"),
    );
  });
});
