// apps/frontend/src/ui-overrides.ts
//
// DRW-186 Task 6 — регистрация двух tool item'ов в нативном tldraw overflow
// popover через `TLUiOverrides.tools`:
//   1) `schema-container` — drag-from-corner создание SchemaContainer (kbd `c`).
//   2) `mermaid-import` — открывает Mermaid Import modal (kbd `⌘M` / `$m`).
//
// Заменяет inline-кнопку "M" в primary toolbar slot
// (`buildTldrawComponents.Toolbar`). Probe §1.1–1.4 описывает контракт
// `TLUiOverrides`/`TLUiToolItem`/`TLUiAssetUrlOverrides`.

import type { TLUiAssetUrlOverrides, TLUiOverrides } from "tldraw";

export interface BuildUiOverridesOpts {
  /**
   * Callback вызывается при выборе Mermaid tool item (клик в overflow popover
   * или нажатие kbd). App.tsx прокидывает сюда `() => setMermaidOpen(true)`.
   */
  onMermaidImport: () => void;
}

/**
 * Build `TLUiOverrides` для `<Tldraw overrides={...} />`.
 *
 * `tools(editor, tools, helpers)` — мутируем копию default tools map: tldraw
 * под капотом превращает её в массив + дополняет overflow popover'ом, если
 * primary slot переполнен (см. probe §1.1).
 */
export function buildUiOverrides(opts: BuildUiOverridesOpts): TLUiOverrides {
  const { onMermaidImport } = opts;
  return {
    tools(editor, tools) {
      tools["schema-container"] = {
        id: "schema-container",
        label: "Container",
        icon: "tool-schema-container",
        kbd: "c",
        onSelect: () => {
          editor.setCurrentTool("schema-container");
        },
      };
      tools["mermaid-import"] = {
        id: "mermaid-import",
        label: "Mermaid",
        icon: "tool-mermaid",
        // `$m` — legacy modifier syntax tldraw: `$` = cmd/ctrl. Используется
        // только для отображения hotkey hint в tooltip; реальный listener
        // живёт в App.tsx (window keydown), см. probe §1.2.
        kbd: "$m",
        onSelect: () => {
          onMermaidImport();
        },
      };
      return tools;
    },
  };
}

/**
 * Asset URL overrides для двух кастомных tool icons. Vite раздаёт `public/`
 * с корня; tldraw применяет SVG как CSS `mask` (single-color силуэт через
 * `currentColor`). См. probe §1.4.
 */
export const SHEMMA_ASSET_URLS: TLUiAssetUrlOverrides = {
  icons: {
    "tool-schema-container": "/icons/tool-schema-container.svg",
    "tool-mermaid": "/icons/tool-mermaid.svg",
  },
};
