import { describe, expect, test } from "bun:test";
import {
  ICON_ERROR,
  ICON_MENU_BOARD,
  ICON_MENU_CONFIG,
  ICON_MENU_LOG,
  ICON_MENU_PLAY,
  ICON_MENU_RESTART,
  ICON_MENU_SPACES,
  ICON_MENU_STOP,
  ICON_MENU_STOP_ALL,
  ICON_MENU_UPDATE,
  ICON_RUNNING,
  ICON_STOPPED,
} from "../src/menubar/icons";

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

const MENU_ICONS = [
  ICON_MENU_PLAY,
  ICON_MENU_STOP,
  ICON_MENU_RESTART,
  ICON_MENU_STOP_ALL,
  ICON_MENU_BOARD,
  ICON_MENU_SPACES,
  ICON_MENU_LOG,
  ICON_MENU_CONFIG,
  ICON_MENU_UPDATE,
];

describe("menubar icons", () => {
  test("статусные и меню-иконки — непустой base64 PNG", () => {
    for (const icon of [
      ICON_RUNNING,
      ICON_STOPPED,
      ICON_ERROR,
      ...MENU_ICONS,
    ]) {
      expect(icon.length).toBeGreaterThan(100);
      expect(icon).toMatch(BASE64_RE);
      // PNG magic bytes в base64 начинаются с iVBOR
      expect(icon.startsWith("iVBOR")).toBe(true);
    }
  });

  test("статусные иконки различаются (разные цвета)", () => {
    expect(ICON_RUNNING).not.toBe(ICON_STOPPED);
    expect(ICON_STOPPED).not.toBe(ICON_ERROR);
  });

  test("меню-иконки различаются (разные символы)", () => {
    expect(new Set(MENU_ICONS).size).toBe(MENU_ICONS.length);
  });
});
