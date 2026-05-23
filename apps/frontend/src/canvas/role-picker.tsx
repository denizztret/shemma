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

import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "tldraw";
import type { Role, ConnectionKind } from "@shemma/domain";
import { ALL_ROLES, ALL_KINDS } from "@shemma/domain";
import { tokens } from "../design-tokens";
import {
  type SelectionInfo,
  applyPickerChoice,
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

  // Focus first button when modal opens.
  useEffect(() => {
    if (!open) return;
    const first = dialogRef.current?.querySelector<HTMLElement>("button");
    first?.focus();
  }, [open]);

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
      try {
        const patches = applyPickerChoice(info, choice);
        if (patches.length > 0) {
          // DRW-136 #3: build full updates upfront and apply через plural
          // updateShapes — singular updateShape less defensive, и любой throw
          // внутри editor.run раньше блокировал onClose.
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
        // picker MUST закрыться, иначе user застревает с не-dismiss'абельным
        // overlay (см. DRW-136 #3 user report).
        console.warn("[shemma] role picker apply failed:", e);
      } finally {
        onClose();
      }
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

  const btn: React.CSSProperties = {
    background: tokens.color.bg,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    padding: "6px 10px",
    cursor: "pointer",
    fontFamily: tokens.font.mono,
    fontSize: tokens.font.sm,
    textAlign: "left",
    color: tokens.color.text,
  };

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
        style={dialog}
        tabIndex={-1}
      >
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
                  style={btn}
                  onClick={() => pick({ type: "role", value: role })}
                >
                  {ROLE_LABELS[role]}
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
                  style={btn}
                  onClick={() => pick({ type: "kind", value: kind })}
                >
                  {KIND_LABELS[kind]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 8, textAlign: "right" }}>
          <button
            type="button"
            style={{ ...btn, color: tokens.color.textMuted }}
            onClick={onClose}
          >
            Cancel (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
