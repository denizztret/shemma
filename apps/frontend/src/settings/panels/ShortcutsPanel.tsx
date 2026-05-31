import { type FC, useCallback, useEffect, useRef, useState } from "react";
import {
  clearAllOverrides,
  clearOverride,
  getActiveBinding,
  hasOverride,
  setOverride,
  subscribe,
} from "../shortcuts/config";
import {
  type Binding,
  bindingFromEvent,
  bindingsEqual,
  formatBinding,
} from "../shortcuts/match";
import {
  SHORTCUT_REGISTRY,
  type ShortcutCategory,
} from "../shortcuts/registry";

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  ai: "AI",
  layout: "Раскладка",
  export: "Экспорт",
  picker: "Семантика",
  settings: "Панель",
};

export type ShortcutsPanelProps = {
  onBack: () => void;
};

/**
 * Settings drill-down for remapping keyboard shortcuts. Global (browser-level)
 * preference — not per-room. Reads the registry + config directly and writes
 * overrides via setOverride / clearOverride.
 */
export const ShortcutsPanel: FC<ShortcutsPanelProps> = ({ onBack }) => {
  // Bump on config change so binding labels re-render after a remap/reset.
  const [, setTick] = useState(0);
  // The command id currently capturing a new chord, or null.
  const [capturing, setCapturing] = useState<string | null>(null);
  // Conflict surfaced during capture: { id (this command), other (conflicting label) }.
  const [conflict, setConflict] = useState<{ id: string; other: string } | null>(
    null,
  );
  const capturingRef = useRef<string | null>(null);
  capturingRef.current = capturing;

  useEffect(() => subscribe(() => setTick((t) => t + 1)), []);

  const stopCapture = useCallback(() => {
    setCapturing(null);
    setConflict(null);
  }, []);

  // Find a different command whose active binding equals `b` (conflict check).
  const findConflict = useCallback(
    (selfId: string, b: Binding): string | null => {
      for (const cmd of SHORTCUT_REGISTRY) {
        if (cmd.id === selfId) continue;
        if (bindingsEqual(getActiveBinding(cmd.id), b)) return cmd.label;
      }
      return null;
    },
    [],
  );

  // Capture keydown while a row is in capture mode. Bound to window in capture
  // phase so tldraw's shortcut router doesn't swallow the chord first.
  useEffect(() => {
    if (!capturing) return;
    function onKey(e: KeyboardEvent) {
      const id = capturingRef.current;
      if (!id) return;
      // Esc cancels capture (a bare Escape, no modifiers).
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        stopCapture();
        return;
      }
      const next = bindingFromEvent(e);
      // Bare modifier (Meta/Ctrl/Alt/Shift) → keep waiting.
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      const other = findConflict(id, next);
      if (other) {
        // Surface the conflict but still apply the remap (user can re-bind the
        // other command, or reset). Both commands firing on one chord is the
        // documented consequence — we warn rather than block.
        setConflict({ id, other });
      }
      setOverride(id, next);
      setCapturing(null);
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing, findConflict, stopCapture]);

  return (
    <div
      className="settings-popover__panel settings-popover__panel--shortcuts"
      role="dialog"
      aria-label="Горячие клавиши"
    >
      <div className="settings-popover__header">
        <button type="button" onClick={onBack} className="settings-link">
          ← Назад
        </button>
        <button
          type="button"
          onClick={() => clearAllOverrides()}
          className="settings-link settings-link--muted"
        >
          Сбросить всё
        </button>
      </div>
      <div className="settings-shortcuts__list">
        {SHORTCUT_REGISTRY.map((cmd) => {
          const active = getActiveBinding(cmd.id);
          const overridden = hasOverride(cmd.id);
          const isCapturing = capturing === cmd.id;
          return (
            <div
              key={cmd.id}
              className="settings-shortcuts__row"
              data-command={cmd.id}
            >
              <div className="settings-shortcuts__meta">
                <span
                  className="settings-shortcuts__label settings-tooltip"
                  data-tooltip={cmd.description}
                >
                  {cmd.label}
                </span>
                <span className="settings-shortcuts__category">
                  {CATEGORY_LABELS[cmd.category]}
                </span>
              </div>
              <div className="settings-shortcuts__controls">
                {isCapturing ? (
                  <span
                    className="settings-shortcuts__capturing"
                    role="status"
                  >
                    нажмите комбинацию…
                  </span>
                ) : (
                  <kbd className="settings-shortcuts__binding">
                    {formatBinding(active)}
                  </kbd>
                )}
                <button
                  type="button"
                  className="settings-btn settings-shortcuts__remap"
                  onClick={() => {
                    setConflict(null);
                    setCapturing((cur) => (cur === cmd.id ? null : cmd.id));
                  }}
                  aria-pressed={isCapturing}
                >
                  {isCapturing ? "Отмена" : "Изменить"}
                </button>
                {overridden && (
                  <button
                    type="button"
                    className="settings-link settings-link--muted settings-shortcuts__reset"
                    onClick={() => clearOverride(cmd.id)}
                  >
                    Сброс
                  </button>
                )}
              </div>
              {conflict && conflict.id === cmd.id && (
                <div className="settings-shortcuts__conflict" role="alert">
                  Конфликт с «{conflict.other}» — обе команды сработают на эту
                  комбинацию.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
