// DRW-217 / DRW-230: кнопка темы 🌓 в шапке доски. Обычный клик — светлая⇄тёмная,
// Opt-клик (altHeld) — системная; иконка отражает режим / 🌓 при зажатом Opt.
// Делегирует в ChromeButton — проверяем переданные props.
import { describe, expect, test } from "bun:test";
import { type ReactElement, isValidElement } from "react";
import { ChromeButton } from "../chrome/ChromeButton";
import { ThemeToggleButton } from "./ThemeToggleButton";
import type { ColorMode, ThemeMode } from "./theme-mode";

type AnyElement = ReactElement<{
  children?: unknown;
  [key: string]: unknown;
}>;

function flatten(node: unknown): AnyElement[] {
  if (node === null || node === undefined || node === false || node === true)
    return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (isValidElement(node)) {
    const el = node as AnyElement;
    return [el, ...flatten(el.props.children)];
  }
  return [];
}

function findChromeButton(root: unknown): AnyElement | null {
  return flatten(root).find((el) => el.type === ChromeButton) ?? null;
}

function render(props: {
  mode: ThemeMode;
  colorMode?: ColorMode;
  altHeld?: boolean;
  onSelect?: (m: ThemeMode) => void;
}): AnyElement | null {
  return findChromeButton(
    ThemeToggleButton({
      mode: props.mode,
      colorMode: props.colorMode ?? "light",
      altHeld: props.altHeld ?? false,
      onSelect: props.onSelect ?? (() => {}),
    }),
  );
}

describe("ThemeToggleButton", () => {
  test("renders a ChromeButton with aria-label including current mode", () => {
    const cb = render({ mode: "dark" });
    expect(cb).not.toBeNull();
    expect(String(cb?.props.ariaLabel)).toContain("Тема");
  });

  test("icon reflects mode when Opt is not held: light ☀️ / dark 🌙 / system 🌓", () => {
    expect(render({ mode: "light" })?.props.children).toBe("☀️");
    expect(render({ mode: "dark" })?.props.children).toBe("🌙");
    expect(render({ mode: "system" })?.props.children).toBe("🌓");
  });

  test("Opt held → icon previews system 🌓 regardless of mode", () => {
    expect(render({ mode: "light", altHeld: true })?.props.children).toBe("🌓");
    expect(render({ mode: "dark", altHeld: true })?.props.children).toBe("🌓");
  });

  test("plain click toggles light⇄dark by visible colorMode (never system)", () => {
    const picks: ThemeMode[] = [];
    const onSelect = (m: ThemeMode) => picks.push(m);
    (render({ mode: "dark", colorMode: "dark", onSelect })?.props.onClick as () => void)();
    (render({ mode: "light", colorMode: "light", onSelect })?.props.onClick as () => void)();
    // From a system mode resolving to dark, a plain click still flips to light.
    (render({ mode: "system", colorMode: "dark", onSelect })?.props.onClick as () => void)();
    expect(picks).toEqual(["light", "dark", "light"]);
  });

  test("Opt-click selects system", () => {
    let picked: ThemeMode | null = null;
    const cb = render({
      mode: "light",
      colorMode: "light",
      altHeld: true,
      onSelect: (m) => {
        picked = m;
      },
    });
    (cb?.props.onClick as () => void)();
    expect(picked).toBe("system");
  });

  test("marked with dataRole for live identification", () => {
    expect(render({ mode: "system" })?.props.dataRole).toBe("theme-toggle");
  });
});
