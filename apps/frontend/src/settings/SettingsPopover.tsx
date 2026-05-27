import { useEffect, useRef, useState, type FC } from "react";
import { useEditor, useValue, type Editor } from "tldraw";
import { useSettingsTrigger } from "./useSettingsTrigger";
import { computePopoverPosition } from "./position";
import { SelectionPanel } from "./panels/SelectionPanel";
import { NodePanel } from "./panels/NodePanel";
import { BoardPanel } from "./panels/BoardPanel";
import { BoardPanelAdvanced } from "./panels/BoardPanelAdvanced";
import {
  getLayoutParams, postLayoutParams, postLayoutSelection,
  getStyleDefaults, postStyleDefaults,
  getContainerTitlePosition, postContainerTitlePosition,
  type LayoutParamsResponse, type StyleDefaultsResponse,
} from "./api";
import { applyPreset, type PresetName } from "./presets";
import { setContainerDirection } from "../shapes/schema-container/SchemaContainerActions";
import { setContainerLayoutParams } from "../shapes/container-layout-params";
import { scopeFor } from "../canvas/tidy-layout";
import type { LayoutSettingsValue } from "./sections/LayoutSettingsSection";
import type { StyleSectionValue } from "./sections/StylesSection";
import type { LayoutParams, Role, StyleDefaults, StyleDash, StyleFont, StyleSize, ResolvedStyleDefaults } from "@shemma/domain";
import { DEFAULT_STYLE_DEFAULTS } from "@shemma/domain";
import { applyStyleToSelection, collectDescendantIds } from "../shapes/style-apply";
import { deriveUnifiedStyleState, type StyleStateInput } from "../shapes/derive-unified-style-state";
import {
  normalizeTitlePosition,
  type SchemaContainerTitlePosition,
} from "../shapes/schema-container/title-position";
import type { SchemaContainerShape } from "../shapes/schema-container/SchemaContainerShape";

export type SettingsPopoverProps = { space: string; room: string };

const POPOVER_SIZE = { width: 240, height: 280 };
const ADVANCED_SIZE = { width: 320, height: 480 };

const isContainerShape = (s: { type: string }): boolean =>
  s.type === "schema-container" || s.type === "frame";

export const SettingsPopover: FC<SettingsPopoverProps> = ({ space, room }) => {
  const editor = useEditor();
  const { target, close, pinned, setPinned } = useSettingsTrigger(editor);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [boardParams, setBoardParams] = useState<LayoutParamsResponse | null>(null);
  const [styleDefaults, setStyleDefaults] = useState<StyleDefaultsResponse | null>(null);
  const [containerTitlePosition, setContainerTitlePosition] =
    useState<SchemaContainerTitlePosition>("inside-center");
  const [pending, setPending] = useState<"tidy" | "force-unpin" | null>(null);
  const [userPos, setUserPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!target) { setAdvanced(false); setBoardParams(null); setStyleDefaults(null); setUserPos(null); }
  }, [target]);

  useEffect(() => {
    if (target?.kind === "board") {
      getLayoutParams(space, room).then(setBoardParams).catch(() => setBoardParams(null));
      getStyleDefaults(space, room).then(setStyleDefaults).catch(() => setStyleDefaults(null));
    }
  }, [target, space, room]);

  // Board-default container title position: fetch on mount / room switch.
  useEffect(() => {
    getContainerTitlePosition(space, room)
      .then((r) => setContainerTitlePosition(normalizeTitlePosition(r.value)))
      .catch(() => setContainerTitlePosition("inside-center"));
  }, [space, room]);

  // Mirror current value into editor.documentSettings.meta so SchemaContainerTool
  // can read board-default at shape-creation time via resolveBoardTitlePosition().
  useEffect(() => {
    if (!editor) return;
    const meta = (editor.getDocumentSettings().meta ?? {}) as Record<string, unknown>;
    if (meta.containerTitlePosition !== containerTitlePosition) {
      editor.updateDocumentSettings({
        meta: { ...meta, containerTitlePosition },
      });
    }
  }, [editor, containerTitlePosition]);

  const onContainerTitlePositionChange = async (
    next: SchemaContainerTitlePosition,
  ) => {
    // Optimistic update; revert on POST failure.
    setContainerTitlePosition(next);
    try {
      await postContainerTitlePosition(space, room, next);
    } catch {
      try {
        const r = await getContainerTitlePosition(space, room);
        setContainerTitlePosition(normalizeTitlePosition(r.value));
      } catch {
        setContainerTitlePosition("inside-center");
      }
    }
  };

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

  async function handleBoardStyle<K extends keyof StyleDefaults>(
    key: K,
    value: NonNullable<StyleDefaults[K]>,
  ) {
    const prev = styleDefaults;
    const nextRaw: StyleDefaults = { ...(prev?.raw ?? {}), [key]: value };
    const nextEffective: ResolvedStyleDefaults = {
      ...(prev?.effective ?? DEFAULT_STYLE_DEFAULTS),
      [key]: value,
    };
    setStyleDefaults({ raw: nextRaw, effective: nextEffective });
    try {
      const r = await postStyleDefaults(space, room, nextRaw);
      setStyleDefaults({ raw: nextRaw, effective: r.effective });
    } catch {
      setStyleDefaults(prev);
    }
  }

  const size = target.kind === "board" && advanced ? ADVANCED_SIZE : POPOVER_SIZE;
  // DRW-188: editor.getViewportScreenBounds() returns canvas-area bounds
  // (excludes chrome toolbar). Popover top-left default = under chrome.
  const vp = editor.getViewportScreenBounds();
  const anchoredPos = computePopoverPosition({
    anchor: target.anchor,
    popoverSize: size,
    viewport: { width: vp.w, height: vp.h, top: vp.y, left: vp.x },
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
          styleEffective={styleDefaults?.effective ?? DEFAULT_STYLE_DEFAULTS}
          onStyleDash={(v) => handleBoardStyle("dash", v)}
          onStyleFont={(v) => handleBoardStyle("font", v)}
          onStyleSize={(v) => handleBoardStyle("size", v)}
          containerTitlePosition={containerTitlePosition}
          onContainerTitlePositionChange={onContainerTitlePositionChange}
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
    const containers = selected.filter(isContainerShape).length;
    return { containers, nodes: selected.length - containers };
  }, [editor]);

  const showContainerSections = counts.containers > 0 && counts.nodes === 0;

  const direction = useValue("dir", () => {
    const containers = (editor.getSelectedShapes() as unknown as Array<{
      type: string;
      props?: { direction?: string };
      meta?: { didrawDirection?: string };
    }>).filter(isContainerShape);
    if (containers.length === 0) return null;
    const readDir = (s: { type: string; props?: { direction?: string }; meta?: { didrawDirection?: string } }) =>
      s.type === "schema-container"
        ? (s.props?.direction ?? null)
        : (s.meta?.didrawDirection ?? null);
    const first = readDir(containers[0]!);
    return containers.every((c) => readDir(c) === first) ? first : null;
  }, [editor]) as "TB" | "LR" | "BT" | "RL" | "custom" | null;

  // Spec 7.3: aggregate layout-params overrides across selected containers.
  // null per field = mixed / indeterminate (rendered as "Avto-направление: —" etc.).
  const layoutSettings = useValue<LayoutSettingsValue>("layoutSettings", () => {
    const containers = (editor.getSelectedShapes() as unknown as Array<{
      type: string;
      meta?: { didrawLayoutParams?: Record<string, unknown> };
    }>).filter(isContainerShape);
    if (containers.length === 0) {
      return { preset: null, autoDirection: null, midpoint: null };
    }

    const readSpacing = (s: { meta?: { didrawLayoutParams?: Record<string, unknown> } }):
      "compact" | "normal" | "loose" | null => {
      const v = s.meta?.didrawLayoutParams?.spacing;
      return v === "compact" || v === "normal" || v === "loose" ? v : null;
    };
    const readAuto = (s: { meta?: { didrawLayoutParams?: Record<string, unknown> } }): boolean | null => {
      const v = s.meta?.didrawLayoutParams?.autoDirectionEnabled;
      return typeof v === "boolean" ? v : null;
    };
    const readMid = (s: { meta?: { didrawLayoutParams?: Record<string, unknown> } }):
      "even" | "fixed-0.5" | null => {
      const v = s.meta?.didrawLayoutParams?.midpointDistribution;
      return v === "even" || v === "fixed-0.5" ? v : null;
    };

    const spaces = containers.map(readSpacing);
    const autos = containers.map(readAuto);
    const mids = containers.map(readMid);

    const allSame = <T,>(arr: T[]): T | null =>
      arr.length > 0 && arr.every((v) => v === arr[0]) ? arr[0]! : null;

    return {
      preset: allSame(spaces),
      autoDirection: allSame(autos),
      midpoint: allSame(mids),
    };
  }, [editor]);

  // Show Reset link if ANY selected container has an explicit meta.didrawLayoutParams override.
  const showReset = useValue("showReset", () => {
    const containers = (editor.getSelectedShapes() as unknown as Array<{
      type: string;
      meta?: { didrawLayoutParams?: unknown };
    }>).filter(isContainerShape);
    return containers.some((s) => {
      const lp = s.meta?.didrawLayoutParams;
      return lp !== undefined && lp !== null;
    });
  }, [editor]);

  const pinValues = useValue("pinValues", () => {
    const selected = editor.getSelectedShapes() as unknown as Array<{ meta?: { pinned?: boolean; didrawSizePinned?: boolean } }>;
    return {
      size: selected.length > 0 && selected.every((s) => s.meta?.didrawSizePinned === true),
      position: selected.length > 0 && selected.every((s) => s.meta?.pinned === true),
    };
  }, [editor]);

  // Style section: visible if selection contains ≥1 frame/schema-container.
  const showStyles = useValue("showStyles", () => {
    const selected = editor.getSelectedShapes() as unknown as Array<{ type: string }>;
    return selected.some(isContainerShape);
  }, [editor]);

  // Per-container titlePosition override (Task 9): visible only when ровно один
  // SchemaContainer выбран. Writeback идёт напрямую в `shape.props.titlePosition`
  // (render-time SSOT по спецификации §Title position resolution).
  const singleContainer = useValue(
    "single-container",
    () => {
      const ids = editor.getSelectedShapeIds();
      if (ids.length !== 1) return null;
      const shape = editor.getShape(ids[0]!);
      return shape?.type === "schema-container"
        ? (shape as SchemaContainerShape)
        : null;
    },
    [editor],
  );

  const onSingleContainerTitlePositionChange = (
    next: SchemaContainerTitlePosition,
  ) => {
    if (!singleContainer) return;
    editor.updateShape({
      id: singleContainer.id,
      type: "schema-container",
      props: { titlePosition: next },
    });
  };

  // DRW-186 frame-scope: визуально такой же 4-toggle, но scope — bulk-apply
  // на всех SchemaContainer-детей внутри выбранного Frame'а + memo на
  // frame.meta.didrawContainerTitlePosition (используется при создании новых
  // child-контейнеров — см. registerContainerTitlePositionInherit).
  const singleFrame = useValue(
    "single-frame",
    () => {
      const ids = editor.getSelectedShapeIds();
      if (ids.length !== 1) return null;
      const shape = editor.getShape(ids[0]!);
      return shape?.type === "frame"
        ? (shape as { id: string; type: string; meta?: Record<string, unknown> })
        : null;
    },
    [editor],
  );

  const singleFrameContainerTitlePosition: SchemaContainerTitlePosition | undefined =
    singleFrame
      ? normalizeTitlePosition(
          (singleFrame.meta as Record<string, unknown> | undefined)
            ?.didrawContainerTitlePosition,
        )
      : undefined;

  const onSingleFrameContainerTitlePositionChange = (
    next: SchemaContainerTitlePosition,
  ) => {
    if (!singleFrame) return;
    editor.run(() => {
      // 1. Memo на Frame meta — для inheritance newly-created child containers.
      // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
      editor.updateShape({
        id: singleFrame.id as never,
        type: "frame" as never,
        meta: { ...(singleFrame.meta ?? {}), didrawContainerTitlePosition: next },
      } as any);
      // 2. Bulk-apply ко всем existing SchemaContainer-детям.
      const childIds = editor.getSortedChildIdsForParent(singleFrame.id as never);
      for (const childId of childIds) {
        const child = editor.getShape(childId);
        if (child?.type !== "schema-container") continue;
        editor.updateShape({
          id: child.id,
          type: "schema-container",
          props: { titlePosition: next },
        });
      }
    });
  };

  // Derive unified style state from selected + descendants.
  const styleState = useValue<StyleSectionValue>("styleState", () => {
    const selectedIds = editor.getSelectedShapeIds() as unknown as string[];
    if (selectedIds.length === 0) return { dash: null, font: null, size: null };

    const visited = collectDescendantIds(editor, selectedIds);
    const inputs: StyleStateInput[] = [];
    for (const id of visited) {
      const s = editor.getShape(id as never) as
        | { type: string; props?: Record<string, unknown> }
        | undefined;
      if (!s) continue;
      inputs.push({ type: s.type, props: (s.props ?? {}) as Record<string, unknown> });
    }
    return deriveUnifiedStyleState(inputs);
  }, [editor]);

  // Spec 4.1 + 7.4: writer пишет `meta.didrawLayoutParams = partial` целиком (replace).
  // Если user меняет ONE field — без accumulate он бы потерял остальные overrides.
  // Frontend accumulate: читаем existing override у первого selected container'а и
  // merge'им с новым subset. Multi-selection с different overrides — picked first
  // (acceptable: mixed state UI уже indicated через null в layoutSettings).
  const buildPartial = (override: Partial<LayoutParams>): Partial<LayoutParams> => {
    const sel = editor.getSelectedShapes() as unknown as Array<{
      type: string;
      meta?: { didrawLayoutParams?: Record<string, unknown> };
    }>;
    const firstContainer = sel.find(isContainerShape);
    const current = (firstContainer?.meta?.didrawLayoutParams ?? {}) as Partial<LayoutParams>;
    return { ...current, ...override };
  };

  return (
    <SelectionPanel
      counts={counts}
      showContainerSections={showContainerSections}
      direction={direction}
      onDirectionChange={(d) => {
        if (d === "custom") return;
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        setContainerDirection(editor, ids, d);
      }}
      layoutSettings={layoutSettings}
      onPreset={(p) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void setContainerLayoutParams(editor, ids, buildPartial({ spacing: p }));
      }}
      onAutoDirection={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void setContainerLayoutParams(editor, ids, buildPartial({ autoDirectionEnabled: v }));
      }}
      onMidpoint={(m) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void setContainerLayoutParams(editor, ids, buildPartial({ midpointDistribution: m }));
      }}
      onAdvanced={() => {
        // Full per-container Advanced UX — отложено в отдельную задачу.
        // BoardPanel-level Advanced остаётся доступен через клик по empty space → Board.
        console.warn("[settings] Advanced drill-down per-container — future work");
      }}
      onReset={() => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void setContainerLayoutParams(editor, ids, null);
      }}
      showReset={showReset}
      onLayoutAction={async (id) => {
        setPending(id);
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        try {
          await postLayoutSelection(space, room, {
            ids,
            scope: scopeFor(ids, editor),
            forceUnpin: id === "force-unpin",
          });
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
      showStyles={showStyles}
      styleState={styleState}
      onStyleDash={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { dash: v });
      }}
      onStyleFont={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { font: v });
      }}
      onStyleSize={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { size: v });
      }}
      singleContainerTitlePosition={singleContainer?.props.titlePosition}
      onSingleContainerTitlePositionChange={
        singleContainer ? onSingleContainerTitlePositionChange : undefined
      }
      singleFrameContainerTitlePosition={singleFrameContainerTitlePosition}
      onSingleFrameContainerTitlePositionChange={
        singleFrame ? onSingleFrameContainerTitlePositionChange : undefined
      }
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
