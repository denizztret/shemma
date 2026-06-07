// DRW-217: кнопка темы 🌓 в шапке доски (цикл light → dark → system).
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
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

function findButton(root: unknown): AnyElement | null {
  return flatten(root).find((el) => el.type === "button") ?? null;
}

describe("ThemeToggleButton", () => {
  test("renders a button with aria-label including current mode", () => {
    const btn = findButton(
      ThemeToggleButton({ mode: "dark", onCycle: () => {} }),
    );
    expect(btn).not.toBeNull();
    expect(String(btn!.props["aria-label"])).toContain("Тема");
  });

  test("click invokes onCycle", () => {
    let cycled = 0;
    const btn = findButton(
      ThemeToggleButton({
        mode: "light",
        onCycle: () => {
          cycled += 1;
        },
      }),
    );
    (btn?.props.onClick as () => void)?.();
    expect(cycled).toBe(1);
  });

  test("icon reflects mode: light ☀ / dark 🌙 / system 🌓", () => {
    const icon = (mode: "light" | "dark" | "system") => {
      const btn = findButton(ThemeToggleButton({ mode, onCycle: () => {} }));
      return flatten(btn)
        .map((el) =>
          typeof el.props.children === "string" ? el.props.children : "",
        )
        .join("")
        .concat(
          typeof btn?.props.children === "string"
            ? (btn.props.children as string)
            : "",
        );
    };
    expect(icon("light")).toContain("☀");
    expect(icon("dark")).toContain("🌙");
    expect(icon("system")).toContain("🌓");
  });

  test("marked with data-role for live identification", () => {
    const btn = findButton(
      ThemeToggleButton({ mode: "system", onCycle: () => {} }),
    );
    expect(btn!.props["data-role"]).toBe("theme-toggle");
  });
});
