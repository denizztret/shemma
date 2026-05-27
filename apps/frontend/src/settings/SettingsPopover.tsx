import { useEffect, useRef, useState, type FC } from "react";
import { useEditor, useValue, type Editor } from "tldraw";
import { useSettingsTrigger } from "./useSettingsTrigger";
import { computePopoverPosition } from "./position";
import { SelectionPanel } from "./panels/SelectionPanel";
import { NodePanel } from "./panels/NodePanel";
import { BoardPanel } from "./panels/BoardPanel";
import { BoardPanelAdvanced } from "./panels/BoardPanelAdvanced";
import {
  getLayoutParams, postLayoutParams, postLayoutSelection, type LayoutParamsResponse,
} from "./api";
import { applyPreset, type PresetName } from "./presets";
import { setContainerDirection } from "../shapes/schema-container/SchemaContainerActions";
import type { LayoutParams, Role } from "@shemma/domain";

export type SettingsPopoverProps = { space: string; room: string };

const POPOVER_SIZE = { width: 240, height: 280 };
const ADVANCED_SIZE = { width: 320, height: 480 };

export const SettingsPopover: FC<SettingsPopoverProps> = ({ space, room }) => {
  const editor = useEditor();
  const { target, close, pinned, setPinned } = useSettingsTrigger(editor);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [boardParams, setBoardParams] = useState<LayoutParamsResponse | null>(null);
  const [pending, setPending] = useState<"tidy" | "force-unpin" | null>(null);
  const [userPos, setUserPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!target) { setAdvanced(false); setBoardParams(null); setUserPos(null); }
  }, [target]);

  useEffect(() => {
    if (target?.kind === "board") {
      getLayoutParams(space, room).then(setBoardParams).catch(() => setBoardParams(null));
    }
  }, [target, space, room]);

  useEffect(() => {
    if (!target || pinned) return;
    function onDown(e: PointerEvent) {
      const el = popoverRef.current;
      if (el && !el.contains(e.target as Node)) close();
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [target, pinned, close]);

  useEffect(() => {
    if (!target) return;
    const el = popoverRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])');
    first?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        el!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')
      );
      if (focusables.length === 0) return;
      const firstEl = focusables[0]!;
      const lastEl = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [target]);

  if (!target) return null;

  const size = target.kind === "board" && advanced ? ADVANCED_SIZE : POPOVER_SIZE;
  const anchoredPos = computePopoverPosition({
    anchor: target.anchor,
    popoverSize: size,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    margin: 16,
  });
  const pos = userPos ?? anchoredPos;

  function onDragStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = userPos ?? anchoredPos;
    const margin = 8;
    const clamp = (x: number, y: number) => ({
      x: Math.max(margin, Math.min(x, window.innerWidth - size.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - margin - 32)),
    });
    function onMove(ev: PointerEvent) {
      setUserPos(clamp(origin.x + (ev.clientX - startX), origin.y + (ev.clientY - startY)));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={popoverRef}
      className="settings-popover"
      style={{
        position: "absolute",
        left: pos.x, top: pos.y,
        width: size.width,
        pointerEvents: "auto",
        zIndex: 1,
      }}
    >
      <div className="settings-popover__top-bar">
        <div
          className="settings-popover__drag-handle"
          onPointerDown={onDragStart}
          title="Перетащить"
          aria-hidden="true"
        >
          <span className="settings-popover__drag-dots">⋯</span>
        </div>
        <button
          type="button"
          className={`settings-popover__pin-btn${pinned ? " settings-popover__pin-btn--on" : ""}`}
          onClick={() => {
            if (pinned) {
              close();
            } else {
              setUserPos(pos);
              setPinned(true);
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          title={pinned ? "Закрыть" : "Закрепить — менюшка останется открытой, контент будет меняться по выделению"}
          aria-pressed={pinned}
          aria-label={pinned ? "Закрыть" : "Закрепить"}
        >
          {pinned ? "✕" : "📌"}
        </button>
      </div>
      {target.kind === "empty" && (
        <div className="settings-popover__panel settings-popover__panel--empty" role="status">
          <div className="settings-popover__empty">
            Для текущего выделения нет настраиваемых параметров
          </div>
        </div>
      )}
      {target.kind === "selection" && (
        <SelectionPanelContainer
          editor={editor}
          space={space}
          room={room}
          pending={pending}
          setPending={setPending}
        />
      )}
      {target.kind === "node" && (
        <NodePanelContainer
          editor={editor}
          subjectId={target.subjectId}
        />
      )}
      {target.kind === "board" && !advanced && boardParams && (
        <BoardPanel
          effective={boardParams.effective}
          onDirectionChange={async (d) => {
            if (d === "custom") return;
            const next = { ...(boardParams.raw ?? {}), defaultDirection: d } as Partial<LayoutParams>;
            setBoardParams({ raw: next, effective: { ...boardParams.effective, defaultDirection: d } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onPresetSelect={async (p: PresetName) => {
            const next = applyPreset(boardParams.raw ?? {}, p);
            setBoardParams({ raw: next, effective: { ...boardParams.effective, ...next } as LayoutParams });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onToggleAutoDirection={async (enabled) => {
            const next = { ...(boardParams.raw ?? {}), autoDirectionEnabled: enabled };
            setBoardParams({ raw: next, effective: { ...boardParams.effective, autoDirectionEnabled: enabled } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onMidpointModeChange={async (mode) => {
            const next = { ...(boardParams.raw ?? {}), midpointDistribution: mode };
            setBoardParams({ raw: next, effective: { ...boardParams.effective, midpointDistribution: mode } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onOpenAdvanced={() => setAdvanced(true)}
        />
      )}
      {target.kind === "board" && advanced && boardParams && (
        <BoardPanelAdvanced
          effective={boardParams.effective}
          onFieldChange={async (field, value) => {
            const next = { ...(boardParams.raw ?? {}), [field]: value };
            setBoardParams({ raw: next, effective: { ...boardParams.effective, [field]: value } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onReset={async () => {
            try { const r = await postLayoutParams(space, room, null); setBoardParams({ raw: null, effective: r.effective }); }
            catch { /* keep */ }
          }}
          onBack={() => setAdvanced(false)}
        />
      )}
    </div>
  );
};

const SelectionPanelContainer: FC<{
  editor: Editor;
  space: string;
  room: string;
  pending: "tidy" | "force-unpin" | null;
  setPending: (p: "tidy" | "force-unpin" | null) => void;
}> = ({ editor, space, room, pending, setPending }) => {
  const counts = useValue("selectionCounts", () => {
    const selected = editor.getSelectedShapes() as unknown as Array<{ type: string }>;
    const containers = selected.filter((s) => s.type === "schema-container").length;
    return { containers, nodes: selected.length - containers };
  }, [editor]);

  const direction = useValue("dir", () => {
    const containers = (editor.getSelectedShapes() as unknown as Array<{ type: string; props?: { direction?: string } }>)
      .filter((s) => s.type === "schema-container");
    if (containers.length === 0) return null;
    const first = containers[0]?.props?.direction ?? null;
    return containers.every((c) => (c.props?.direction ?? null) === first) ? first : null;
  }, [editor]) as "TB" | "LR" | "BT" | "RL" | "custom" | null;

  const pinValues = useValue("pinValues", () => {
    const selected = editor.getSelectedShapes() as unknown as Array<{ meta?: { pinned?: boolean; didrawSizePinned?: boolean } }>;
    return {
      size: selected.length > 0 && selected.every((s) => s.meta?.didrawSizePinned === true),
      position: selected.length > 0 && selected.every((s) => s.meta?.pinned === true),
    };
  }, [editor]);

  return (
    <SelectionPanel
      counts={counts}
      direction={direction}
      onDirectionChange={(d) => {
        if (d === "custom") return;
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        setContainerDirection(editor, ids, d);
      }}
      onLayoutAction={async (id) => {
        setPending(id);
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        try {
          await postLayoutSelection(space, room, { ids, forceUnpin: id === "force-unpin" });
        } catch (e) { console.warn("[settings] layout action failed", e); }
        finally { setPending(null); }
      }}
      pinValues={pinValues}
      onPinToggle={(field) => {
        const ids = editor.getSelectedShapeIds();
        editor.run(() => {
          for (const id of ids) {
            const s = editor.getShape(id) as { id: string; type: string; meta?: Record<string, unknown> } | undefined;
            if (!s) continue;
            const key = field === "size" ? "didrawSizePinned" : "pinned";
            const nextVal = !(s.meta?.[key] === true);
            // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
            editor.updateShape({
              id: s.id as never,
              type: s.type as never,
              meta: { ...(s.meta ?? {}), [key]: nextVal },
            } as any);
          }
        });
      }}
      pending={pending}
    />
  );
};

const NodePanelContainer: FC<{
  editor: Editor;
  subjectId: string;
}> = ({ editor, subjectId }) => {
  const pinValues = useValue("nodePinValues", () => {
    const s = editor.getShape(subjectId as never) as { meta?: Record<string, unknown> } | undefined;
    return {
      size: s?.meta?.didrawSizePinned === true,
      position: s?.meta?.pinned === true,
    };
  }, [editor, subjectId]);

  const role = useValue("nodeRole", () => {
    const s = editor.getShape(subjectId as never) as { meta?: { didrawRole?: string } } | undefined;
    return (s?.meta?.didrawRole ?? null) as Role | null;
  }, [editor, subjectId]);

  return (
    <NodePanel
      pinValues={pinValues}
      onPinToggle={(field) => {
        const s = editor.getShape(subjectId as never) as { id: string; type: string; meta?: Record<string, unknown> } | undefined;
        if (!s) return;
        const key = field === "size" ? "didrawSizePinned" : "pinned";
        const nextVal = !(s.meta?.[key] === true);
        // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
        editor.updateShape({
          id: s.id as never,
          type: s.type as never,
          meta: { ...(s.meta ?? {}), [key]: nextVal },
        } as any);
      }}
      role={role}
      onRoleSelect={(r) => {
        const s = editor.getShape(subjectId as never) as { id: string; type: string; meta?: Record<string, unknown> } | undefined;
        if (!s) return;
        // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
        editor.updateShape({
          id: s.id as never,
          type: s.type as never,
          meta: { ...(s.meta ?? {}), didrawRole: r },
        } as any);
      }}
    />
  );
};
