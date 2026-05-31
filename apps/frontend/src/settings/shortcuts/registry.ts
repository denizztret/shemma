/**
 * Central registry of user-configurable keyboard shortcuts.
 *
 * Each command's `defaultBinding` reproduces EXACTLY the modifier/key check the
 * corresponding handler historically hard-coded. These defaults are the
 * regression contract — see shortcuts/match.test.ts.
 */

import type { Binding } from "./match";

export type ShortcutCategory =
  | "ai"
  | "layout"
  | "export"
  | "picker"
  | "settings";

export type ShortcutCommand = {
  /** Stable command id, used as the localStorage override key. */
  id: string;
  /** Human label (Russian, matches existing UI language). */
  label: string;
  category: ShortcutCategory;
  defaultBinding: Binding;
  description: string;
};

export const SHORTCUT_REGISTRY: ReadonlyArray<ShortcutCommand> = [
  {
    id: "prompt",
    label: "AI-промпт",
    category: "ai",
    // ⌘K / Ctrl+K — !shiftKey, key "k". App.tsx inline handler.
    defaultBinding: { mod: true, code: "KeyK" },
    description: "Открыть строку AI-промпта для выделения",
  },
  {
    id: "mermaid-import",
    label: "Импорт Mermaid",
    category: "ai",
    // ⌘M / Ctrl+M — key "m". App.tsx inline handler. NB: the historical handler
    // was `(metaKey||ctrlKey) && key==="m"` with NO shift/alt guard, so ⌘⇧M /
    // ⌘⌥M also opened import. The `{mod, KeyM}` binding adds an implicit
    // !shift && !alt guard (intentional tightening) — see match().
    defaultBinding: { mod: true, code: "KeyM" },
    description: "Открыть окно импорта Mermaid",
  },
  {
    id: "tidy-layout",
    label: "Авто-раскладка",
    category: "layout",
    // ⌘⇧L / Ctrl+Shift+L — shift, !alt, key "l".
    defaultBinding: { mod: true, shift: true, code: "KeyL" },
    description: "Упорядочить выделение (elk auto-layout)",
  },
  {
    id: "force-relayout",
    label: "Принудительно",
    category: "layout",
    // ⌘⌥⇧L / Ctrl+Alt+Shift+L — alt + shift, key "l".
    defaultBinding: { mod: true, alt: true, shift: true, code: "KeyL" },
    description: "Раскладка с игнором пинов и направлений (один проход)",
  },
  {
    id: "copy-link",
    label: "Копировать ссылку",
    category: "export",
    // ⇧⌘S / Ctrl+Shift+S — "S" = Share. Deliberately NOT ⌘⌥C: on macOS Chrome
    // ⌘⌥C is the "Inspect Element" DevTools accelerator and is swallowed by the
    // browser before the page handler ever sees the keydown (CDP-injected keys
    // bypass that layer, which is why automated verification missed it). ⇧⌘S is
    // free of browser accelerators and distinct from ⇧⌘L / ⇧⌘E / ⇧⌘K / ⇧⌘P.
    // Remappable via the shortcuts panel.
    defaultBinding: { mod: true, shift: true, code: "KeyS" },
    description: "Скопировать deep-link на выделенный объект",
  },
  {
    id: "export-miro",
    label: "Экспорт в Miro",
    category: "export",
    // ⌘⇧E / Ctrl+Shift+E — shift, key "e".
    defaultBinding: { mod: true, shift: true, code: "KeyE" },
    description: "Открыть окно экспорта выделения в Miro",
  },
  {
    id: "role-picker",
    label: "Семантика (роль/связь)",
    category: "picker",
    // ⌘⇧K / Ctrl+Shift+K — shift, key "k".
    defaultBinding: { mod: true, shift: true, code: "KeyK" },
    description: "Открыть выбор роли / вида связи для выделения",
  },
  {
    id: "settings-popover",
    label: "Настройки",
    category: "settings",
    // ⌘⇧P / Ctrl+Shift+P — shift, !alt, code "KeyP" / key "p".
    defaultBinding: { mod: true, shift: true, code: "KeyP" },
    description: "Показать / скрыть панель настроек",
  },
];

const BY_ID = new Map(SHORTCUT_REGISTRY.map((c) => [c.id, c]));

export function getCommand(id: string): ShortcutCommand | undefined {
  return BY_ID.get(id);
}
