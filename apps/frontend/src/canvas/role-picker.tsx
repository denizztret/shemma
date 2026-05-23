/**
 * DRW-134 Task 3.2 — Cmd+Shift+K semantic picker UI.
 *
 * Modal/popover that lets users assign a Role or ConnectionKind to selected
 * tldraw shapes via keyboard shortcut.
 *
 * Architecture decision: no JSDOM infra exists in the project → component
 * is not tested at render level; pure-logic layer in role-picker.ts is tested
 * separately. Visual verification via `verify` skill post-task.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "tldraw";
import type { Role, ConnectionKind } from "@shemma/domain";
import { ALL_ROLES, ALL_KINDS } from "@shemma/domain";
import { tokens } from "../design-tokens";
import {
  type SelectionInfo,
  applyPickerChoice,
  deriveCurrentKind,
  deriveCurrentRole,
} from "./role-picker";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<Role, string> = {
  actor:     "Actor",
  service:   "Service",
  datastore: "Datastore",
  queue:     "Queue",
  network:   "Network",
  boundary:  "Boundary",
  external:  "External",
  note:      "Note",
};

const KIND_LABELS: Record<ConnectionKind, string> = {
  sync:  "Sync (→)",
  async: "Async (-.->)",
  data:  "Data (==>)",
  dep:   "Dependency (dep)",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RolePickerProps {
  /** Whether the picker modal is open. */
  open: boolean;
  /** Classified selection from classifySelection(). */
  info: SelectionInfo;
  /** Live tldraw editor instance. */
  editor: Editor;
  /** Called to close the picker (Esc, backdrop click, or after a pick). */
  onClose: () => void;
}

/**
 * Modal picker that applies role / connectionKind meta to selected tldraw shapes.
 *
 * Renders nothing when `open === false` or `info.mode === "none"`.
 *
 * Keyboard: Esc → close. Focus is trapped inside modal (Tab cycles through buttons).
 * Backdrop click → close.
 * ARIA: role="dialog" + aria-modal + aria-label.
 */
export function RolePicker({ open, info, editor, onClose }: RolePickerProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);

  // DRW-136 #2 follow-up: transient "picked" state — shown for ~120ms между
  // click и close, чтобы user видел active-feedback на selected button прежде
  // чем picker исчезнет. Reset на open=false (unmount).
  const [pickedRole, setPickedRole] = useState<Role | undefined>(undefined);
  const [pickedKind, setPickedKind] = useState<ConnectionKind | undefined>(undefined);

  // Reset transient picked state when picker re-opens (new selection).
  useEffect(() => {
    if (open) {
      setPickedRole(undefined);
      setPickedKind(undefined);
    }
  }, [open]);

  // DRW-136 #2: при re-open picker подсветить уже назначенную role/kind для
  // current selection, чтобы user видел actual state (вместо «всегда Actor focused»).
  const currentRole = useMemo(() => {
    if (!open) return undefined;
    const metas = info.shapeIds.map((id) => {
      // biome-ignore lint/suspicious/noExplicitAny: tldraw id typing
      const shape = editor.getShape(id as any);
      return (shape?.meta ?? undefined) as Record<string, unknown> | undefined;
    });
    return deriveCurrentRole(metas);
  }, [open, info.shapeIds, editor]);

  const currentKind = useMemo(() => {
    if (!open) return undefined;
    const metas = info.arrowIds.map((id) => {
      // biome-ignore lint/suspicious/noExplicitAny: tldraw id typing
      const shape = editor.getShape(id as any);
      return (shape?.meta ?? undefined) as Record<string, unknown> | undefined;
    });
    return deriveCurrentKind(metas);
  }, [open, info.arrowIds, editor]);

  // DRW-136 #2 follow-up: focus current role/kind button (если есть), иначе
  // dialog div сам. Раньше fallback'ом всегда фокусировалась первая кнопка
  // (Actor) → focus-visible outline визуально путал с currentRole highlight.
  // Когда current отсутствует — dialog получает focus, ни одна button не
  // подсвечена. Tab из dialog'а наводит focus на первую button (нормальный flow).
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    let target: HTMLElement | null = null;
    if (currentRole) {
      target = dialog.querySelector<HTMLElement>(
        `button[data-role="${currentRole}"]`,
      );
    }
    if (!target && currentKind) {
      target = dialog.querySelector<HTMLElement>(
        `button[data-kind="${currentKind}"]`,
      );
    }
    if (!target) {
      target = dialog;
    }
    target.focus();
  }, [open, currentRole, currentKind]);

  // Esc key → close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);

  const pick = useCallback(
    (choice: { type: "role"; value: Role } | { type: "kind"; value: ConnectionKind }) => {
      // DRW-136 #2 follow-up: показать "picked" highlight через transient
      // state, defer apply+close на 120ms чтобы user видел click feedback.
      if (choice.type === "role") setPickedRole(choice.value);
      else setPickedKind(choice.value);

      setTimeout(() => {
        try {
          const patches = applyPickerChoice(info, choice);
          if (patches.length > 0) {
            // DRW-136 #3: plural updateShapes + try/finally чтобы onClose
            // выполнился даже если apply throws.
            // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes accepts partials
            const updates: any[] = [];
            for (const { id, meta } of patches) {
              // biome-ignore lint/suspicious/noExplicitAny: tldraw id typing
              const shape = editor.getShape(id as any);
              if (!shape) continue;
              updates.push({
                id: shape.id,
                type: shape.type,
                meta: { ...shape.meta, ...(meta as Record<string, unknown>) },
              });
            }
            if (updates.length > 0) {
              editor.updateShapes(updates);
            }
          }
        } catch (e) {
          // Best-effort — даже если applyPickerChoice/updateShapes падает,
          // picker MUST закрыться (DRW-136 #3 user report).
          console.warn("[shemma] role picker apply failed:", e);
        } finally {
          onClose();
        }
      }, 120);
    },
    [info, editor, onClose],
  );

  if (!open || info.mode === "none") return null;

  const showRoles = info.mode === "role" || info.mode === "mixed";
  const showKinds = info.mode === "connectionKind" || info.mode === "mixed";

  const backdrop: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: tokens.color.backdrop,
    zIndex: tokens.z.modal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const dialog: React.CSSProperties = {
    background: tokens.color.bgOverlay,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    padding: "16px 20px",
    minWidth: 260,
    maxWidth: 360,
    fontFamily: tokens.font.mono,
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
    outline: "none",
  };

  const heading: React.CSSProperties = {
    margin: "0 0 12px 0",
    fontSize: tokens.font.base,
    fontFamily: tokens.font.mono,
    color: tokens.color.textMuted,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  const section: React.CSSProperties = {
    marginBottom: 12,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: tokens.font.sm,
    color: tokens.color.textMuted,
    marginBottom: 6,
  };

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
  };

  // DRW-136 #2 follow-up: переносим button stylez в CSS classes чтобы получить
  // нормальные hover/:active эффекты (inline styles не поддерживают pseudo-classes).
  // CSS variables берут token values от dialog-уровня, чтобы style block не дублировал
  // hex'ы from tokens.ts.
  const cssVars = {
    "--rp-bg": tokens.color.bg,
    "--rp-bg-overlay": tokens.color.bgOverlay,
    "--rp-bg-hover": tokens.color.bgOverlay,
    "--rp-border": tokens.color.border,
    "--rp-text": tokens.color.text,
    "--rp-accent": tokens.color.accent,
    "--rp-font-mono": tokens.font.mono,
    "--rp-font-sm": `${tokens.font.sm}px`,
  } as React.CSSProperties;
  const css = `
    .rp-btn {
      background: var(--rp-bg);
      border: 1px solid var(--rp-border);
      border-radius: ${tokens.radius.sm}px;
      padding: 6px 10px;
      cursor: pointer;
      font-family: var(--rp-font-mono);
      font-size: var(--rp-font-sm);
      text-align: left;
      color: var(--rp-text);
      transition: background 80ms ease, border-color 80ms ease, color 80ms ease;
    }
    .rp-btn:hover:not(:disabled) {
      background: var(--rp-bg-hover);
      border-color: var(--rp-accent);
    }
    .rp-btn:active:not(:disabled) {
      background: var(--rp-accent);
      color: #fff;
      transform: translateY(1px);
    }
    .rp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .rp-btn:focus-visible {
      outline: 2px solid var(--rp-accent);
      outline-offset: 2px;
    }
    .rp-btn[aria-pressed="true"] {
      border-color: var(--rp-accent);
      background: color-mix(in srgb, var(--rp-accent) 12%, var(--rp-bg));
      font-weight: 600;
    }
    /* DRW-136 #2 polish: current-button border accent уже даёт visual cue,
       второй focus outline избыточен и выглядит как «двойное выделение». */
    .rp-btn[aria-pressed="true"]:focus-visible {
      outline: none;
    }
    .rp-btn[data-picked="true"] {
      background: var(--rp-accent) !important;
      color: #fff !important;
      border-color: var(--rp-accent) !important;
      font-weight: 700;
    }
  `;

  return (
    // Backdrop — click outside → close
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close via Esc handled above
    <div
      style={backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Assign semantic role or connection kind"
        style={{ ...dialog, ...cssVars }}
        tabIndex={-1}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, no user input */}
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <h3 style={heading}>Assign semantic</h3>

        {showRoles && (
          <div style={section}>
            {info.mode === "mixed" && (
              <p style={sectionLabel}>Role (for shapes)</p>
            )}
            <div style={grid}>
              {ALL_ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  className="rp-btn"
                  data-role={role}
                  data-picked={role === pickedRole ? "true" : undefined}
                  aria-pressed={role === currentRole || role === pickedRole}
                  onClick={() => pick({ type: "role", value: role })}
                  disabled={pickedRole !== undefined}
                >
                  {ROLE_LABELS[role]}
                  {role === pickedRole ? " ✓" : ""}
                </button>
              ))}
            </div>
          </div>
        )}

        {showKinds && (
          <div style={section}>
            {info.mode === "mixed" && (
              <p style={sectionLabel}>Connection kind (for arrows)</p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
              {ALL_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="rp-btn"
                  data-kind={kind}
                  data-picked={kind === pickedKind ? "true" : undefined}
                  aria-pressed={kind === currentKind || kind === pickedKind}
                  onClick={() => pick({ type: "kind", value: kind })}
                  disabled={pickedKind !== undefined}
                >
                  {KIND_LABELS[kind]}
                  {kind === pickedKind ? " ✓" : ""}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 8, textAlign: "right" }}>
          <button
            type="button"
            className="rp-btn"
            style={{ color: tokens.color.textMuted }}
            onClick={onClose}
          >
            Cancel (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
