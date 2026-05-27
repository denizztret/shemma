// DRW-186 Task 10: inline label edit overlay for SchemaContainer.
//
// HTML overlay rendered through `<HTMLContainer>` (sibling to SVG body).
// Switches between static `<div>` label and editable `<input>` based on
// `useIsEditing(shape.id)` — tldraw enters edit-mode through `canEdit() => true`
// override in SchemaContainerShapeUtil (см. probe Task 3).
//
// Edit-mode flow:
//   - Enter focus  → input получает фокус через `requestAnimationFrame`.
//   - Esc          → discard, revert to props.name.
//   - Enter / blur → commit draft в props.name через `editor.updateShape`.
//   - pointerdown / keydown Enter|Escape → `editor.markEventAsHandled`
//     блокирует bubble в SelectTool.Idle (иначе Enter re-input в edit mode).

import { HTMLContainer, useEditor, useIsEditing } from "tldraw";
import { useEffect, useRef, useState } from "react";
import type { SchemaContainerShape } from "./SchemaContainerShape";

/**
 * Variants:
 * - `inside` — текст цвета shape'а (color prop), без bg (фон — body fill SVG).
 * - `outside-frame` — neutral text (`var(--tl-color-text)`), без explicit bg.
 *   В отличие от outside-banner, под overlay'ем НЕТ SVG banner'а — label
 *   плавает прямо над body (native tldraw Frame parity per user feedback
 *   image 29).
 * - `outside-banner` — белый текст, без bg (под overlay — saturated SVG banner).
 *
 * Все варианты используют один и тот же font-size 13px (Frame parity per
 * DRW-186 phase 2 feedback).
 */
export interface SchemaContainerLabelProps {
  shape: SchemaContainerShape;
  labelX: number;
  labelY: number;
  labelW: number;
  labelH: number;
  color: string;
  align: "center" | "left";
  variant: "inside" | "outside-frame" | "outside-banner";
}

export function SchemaContainerLabel({
  shape,
  labelX,
  labelY,
  labelW,
  labelH,
  color,
  align,
  variant,
}: SchemaContainerLabelProps) {
  const editor = useEditor();
  const isEditing = useIsEditing(shape.id);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(shape.props.name);

  useEffect(() => {
    if (isEditing) {
      setDraft(shape.props.name);
      // requestAnimationFrame: ждём пока input смонтируется в DOM
      // прежде чем фокусироваться. Без RAF фокус не схватывается reliably
      // в Strict-mode dev re-mount цикле.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isEditing, shape.props.name]);

  const commit = (value: string) => {
    editor.updateShape({
      id: shape.id,
      type: "schema-container",
      props: { name: value },
    });
    editor.setEditingShape(null);
  };

  const discard = () => {
    editor.setEditingShape(null);
  };

  // Font size унифицирован под 13px для всех вариантов (DRW-186 phase 2 —
  // user feedback "шрифт inside больше, чем полагается"). Native Frame label
  // в tldraw 5.x использует ~12-13px Inter; 13px даёт нам visual parity.
  //
  // Font weight: native Frame label рендерится с regular (400) весом. Для
  // outside-frame / inside-* используем 400 — visual parity. Для outside-banner
  // оставляем 500 (medium) — на saturated coloured bg бледный 400 теряет
  // читаемость, 500 даёт необходимый контраст (user fix image 31).
  const fontStyle: React.CSSProperties = {
    font:
      variant === "outside-banner"
        ? "500 13px var(--tl-font-sans, system-ui, sans-serif)"
        : "400 13px var(--tl-font-sans, system-ui, sans-serif)",
    color:
      variant === "outside-banner"
        ? "#fff"
        : variant === "outside-frame"
          ? "var(--tl-color-text)"
          : color,
  };

  return (
    <HTMLContainer
      style={{
        position: "absolute",
        left: labelX,
        top: labelY,
        width: labelW,
        height: labelH,
        display: "flex",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : "flex-start",
        paddingLeft: align === "left" ? 12 : 0,
        // pointerEvents: только в edit-mode HTML overlay должен ловить клики;
        // в read-mode передаём канвасу tldraw чтобы select/drag работали.
        pointerEvents: isEditing ? "all" : "none",
      }}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              // FrameLabelInput pattern: блокируем bubble до SelectTool.Idle,
              // иначе Enter заново триггерит edit mode (re-enter loop).
              editor.markEventAsHandled(e);
              commit(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              editor.markEventAsHandled(e);
              discard();
            }
          }}
          onPointerDown={(e) => editor.markEventAsHandled(e)}
          onBlur={() => commit(draft)}
          style={{
            ...fontStyle,
            background: "transparent",
            border: "none",
            outline: "1px solid var(--color-selected, #5d5dff)",
            padding: "0 4px",
            width: "calc(100% - 16px)",
            textAlign: align,
          }}
        />
      ) : (
        <div style={{ ...fontStyle, userSelect: "none" }}>{shape.props.name}</div>
      )}
    </HTMLContainer>
  );
}
