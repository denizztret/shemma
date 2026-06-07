// DRW-206: видимая кнопка панели настроек (⚙️) в шапке доски.
// Делегирует в ChromeButton — проверяем переданные props.
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import { ChromeButton } from "../chrome/ChromeButton";
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

function findChromeButton(root: unknown): AnyElement | null {
  return flatten(root).find((el) => el.type === ChromeButton) ?? null;
}

describe("SettingsTriggerButton", () => {
  test("renders a ChromeButton with aria-label «Настройки»", () => {
    const cb = findChromeButton(
      SettingsTriggerButton({ open: false, onToggle: () => {} }),
    );
    expect(cb).not.toBeNull();
    expect(cb!.props.ariaLabel).toBe("Настройки");
  });

  test("click invokes onToggle", () => {
    let toggled = 0;
    const cb = findChromeButton(
      SettingsTriggerButton({
        open: false,
        onToggle: () => {
          toggled += 1;
        },
      }),
    );
    (cb?.props.onClick as (() => void) | undefined)?.();
    expect(toggled).toBe(1);
  });

  test("open state drives active + pressed", () => {
    const off = findChromeButton(
      SettingsTriggerButton({ open: false, onToggle: () => {} }),
    );
    const on = findChromeButton(
      SettingsTriggerButton({ open: true, onToggle: () => {} }),
    );
    expect(off!.props.active).toBe(false);
    expect(off!.props.pressed).toBe(false);
    expect(on!.props.active).toBe(true);
    expect(on!.props.pressed).toBe(true);
  });

  test("marked with dataRole for live identification", () => {
    const cb = findChromeButton(
      SettingsTriggerButton({ open: false, onToggle: () => {} }),
    );
    expect(cb!.props.dataRole).toBe("settings-trigger");
  });

  test("uses gear emoji and stopPointerDown (floating popover guard)", () => {
    const cb = findChromeButton(
      SettingsTriggerButton({ open: false, onToggle: () => {} }),
    );
    expect(cb!.props.children).toBe("⚙️");
    expect(cb!.props.stopPointerDown).toBe(true);
  });
});
