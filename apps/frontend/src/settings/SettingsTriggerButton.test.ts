// DRW-206: видимая кнопка панели настроек (⚙) в шапке доски.
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import { SettingsTriggerButton } from "./SettingsTriggerButton";

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

describe("SettingsTriggerButton", () => {
  test("renders a button with aria-label «Настройки»", () => {
    const tree = SettingsTriggerButton({ open: false, onToggle: () => {} });
    const btn = findButton(tree);
    expect(btn).not.toBeNull();
    expect(btn!.props["aria-label"]).toBe("Настройки");
  });

  test("click invokes onToggle", () => {
    let toggled = 0;
    const tree = SettingsTriggerButton({
      open: false,
      onToggle: () => {
        toggled += 1;
      },
    });
    const onClick = findButton(tree)?.props.onClick as
      | (() => void)
      | undefined;
    onClick?.();
    expect(toggled).toBe(1);
  });

  test("open=true is exposed via aria-pressed (подсветка активного состояния)", () => {
    const off = findButton(
      SettingsTriggerButton({ open: false, onToggle: () => {} }),
    );
    const on = findButton(
      SettingsTriggerButton({ open: true, onToggle: () => {} }),
    );
    expect(off!.props["aria-pressed"]).toBe(false);
    expect(on!.props["aria-pressed"]).toBe(true);
  });

  test("marked with data-role for live identification", () => {
    const btn = findButton(
      SettingsTriggerButton({ open: false, onToggle: () => {} }),
    );
    expect(btn!.props["data-role"]).toBe("settings-trigger");
  });
});
