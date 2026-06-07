// DRW-217: кнопка темы 🌓 в шапке доски (цикл light → dark → system).
// Делегирует в ChromeButton — проверяем переданные props.
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import { ChromeButton } from "../chrome/ChromeButton";
import { ThemeToggleButton } from "./ThemeToggleButton";

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

describe("ThemeToggleButton", () => {
  test("renders a ChromeButton with aria-label including current mode", () => {
    const cb = findChromeButton(
      ThemeToggleButton({ mode: "dark", onCycle: () => {} }),
    );
    expect(cb).not.toBeNull();
    expect(String(cb!.props.ariaLabel)).toContain("Тема");
  });

  test("click invokes onCycle", () => {
    let cycled = 0;
    const cb = findChromeButton(
      ThemeToggleButton({
        mode: "light",
        onCycle: () => {
          cycled += 1;
        },
      }),
    );
    (cb?.props.onClick as (() => void) | undefined)?.();
    expect(cycled).toBe(1);
  });

  test("icon reflects mode: light ☀️ / dark 🌙 / system 🌓", () => {
    const icon = (mode: "light" | "dark" | "system") =>
      findChromeButton(ThemeToggleButton({ mode, onCycle: () => {} }))?.props
        .children;
    expect(icon("light")).toBe("☀️");
    expect(icon("dark")).toBe("🌙");
    expect(icon("system")).toBe("🌓");
  });

  test("marked with dataRole for live identification", () => {
    const cb = findChromeButton(
      ThemeToggleButton({ mode: "system", onCycle: () => {} }),
    );
    expect(cb!.props.dataRole).toBe("theme-toggle");
  });
});
