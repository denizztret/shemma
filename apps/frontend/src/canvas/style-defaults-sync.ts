// apps/frontend/src/canvas/style-defaults-sync.ts
//
// Style propagation (DRW-180 sub-project 3, Task 9):
// двунаправленная синхронизация board-level style defaults между:
//   - tldraw editor instance state (stylesForNextShape, session-scoped)
//   - room.meta.styleDefaults (persistent, через POST /api/board/style-defaults)
//
// + container-level resolution chain через editor.sideEffects.registerBeforeCreateHandler.
//   При создании shape walks parent chain → собирает sticky defaults с frame /
//   schema-container и применяет applyStyleDefaultsResolution к shape.props
//   (per applicability matrix).
//
// WS-applied remote changes игнорируются: store.listen фильтруется source:"user",
// а sideEffects.registerBeforeCreateHandler не вызывается для mergeRemoteChanges.

import {
  ArrowShapeKindStyle,
  DefaultDashStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  type Editor,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import {
  type ArrowKind,
  type StyleDash,
  type StyleDefaults,
  type StyleFont,
  type StyleSize,
} from "@shemma/domain";
import { getStyleDefaults, postStyleDefaults } from "../settings/api";

// Echo-guard TTL: после write в editor.setStyleForNextShapes
// instance update прилетает почти сразу, но допускаем jitter HMR / batching.
const ECHO_TTL_MS = 200;

type EchoEntry = { value: string; expiresAt: number };

// Applicability matrix — какие style keys прокидываются на какие shape types.
// Соответствует style-apply.ts (Task 6) — keep in sync.
const APPLY_DASH: ReadonlySet<string> = new Set([
  "geo",
  "arrow",
  "schema-container",
]);
const APPLY_FONT: ReadonlySet<string> = new Set([
  "geo",
  "note",
  "text",
  "arrow",
]);
const APPLY_SIZE: ReadonlySet<string> = new Set([
  "geo",
  "note",
  "text",
  "arrow",
]);

// Containers, у которых читаем meta.didrawStyleDefaults для resolution chain.
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "frame",
  "schema-container",
]);

function readSticky(shape: TLShape | undefined): StyleDefaults {
  if (!shape) return {};
  if (!CONTAINER_TYPES.has(shape.type)) return {};
  const meta = (shape.meta ?? {}) as Record<string, unknown>;
  const sticky = meta.didrawStyleDefaults;
  if (!sticky || typeof sticky !== "object") return {};
  return sticky as StyleDefaults;
}

export function buildResolutionChain(
  editor: Editor,
  parentId: string | undefined,
): StyleDefaults[] {
  const chain: StyleDefaults[] = [];
  let cursor: string | undefined = parentId;
  // Guard против циклов; tldraw запрещает циклы parent-chain, но защищаемся.
  let hops = 0;
  while (cursor && cursor.startsWith("shape:") && hops < 64) {
    const shape = editor.getShape(cursor as TLShapeId);
    if (!shape) break;
    const sticky = readSticky(shape);
    if (Object.keys(sticky).length > 0) chain.push(sticky);
    cursor = (shape.parentId as string | undefined) ?? undefined;
    hops += 1;
  }
  return chain;
}

export function applyPartialToShape<S extends TLShape>(
  shape: S,
  partial: StyleDefaults,
): S {
  const props = (shape.props ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...props };
  let changed = false;

  if (partial.dash !== undefined && APPLY_DASH.has(shape.type) && next.dash !== partial.dash) {
    next.dash = partial.dash;
    changed = true;
  }
  if (partial.font !== undefined && APPLY_FONT.has(shape.type) && next.font !== partial.font) {
    next.font = partial.font;
    changed = true;
  }
  if (partial.size !== undefined && APPLY_SIZE.has(shape.type) && next.size !== partial.size) {
    next.size = partial.size;
    changed = true;
  }
  if (!changed) return shape;
  return { ...shape, props: next } as S;
}

function isStyleDash(v: unknown): v is StyleDash {
  return v === "draw" || v === "solid";
}
function isStyleFont(v: unknown): v is StyleFont {
  return v === "draw" || v === "sans" || v === "mono";
}
function isStyleSize(v: unknown): v is StyleSize {
  return v === "s" || v === "m" || v === "l" || v === "xl";
}
function isArrowKind(v: unknown): v is ArrowKind {
  return v === "arc" || v === "elbow";
}

/**
 * Register board-level style defaults sync для editor / room.
 *
 * Returns disposer; вызывать на unmount / room-switch / HMR.
 */
export function registerStyleDefaultsSync(
  editor: Editor,
  space: string,
  room: string,
): () => void {
  let roomDefaults: StyleDefaults | null = null;
  let cancelled = false;
  const echo: Map<string, EchoEntry> = new Map();

  function setEcho(key: string, value: string): void {
    echo.set(key, { value, expiresAt: Date.now() + ECHO_TTL_MS });
  }
  function checkEcho(key: string, value: string): boolean {
    const e = echo.get(key);
    if (!e) return false;
    if (Date.now() > e.expiresAt) {
      echo.delete(key);
      return false;
    }
    return e.value === value;
  }

  function applyToEditor(defaults: StyleDefaults): void {
    if (defaults.dash !== undefined) {
      setEcho("dash", defaults.dash);
      editor.setStyleForNextShapes(DefaultDashStyle, defaults.dash);
    }
    if (defaults.font !== undefined) {
      setEcho("font", defaults.font);
      editor.setStyleForNextShapes(DefaultFontStyle, defaults.font);
    }
    if (defaults.size !== undefined) {
      setEcho("size", defaults.size);
      editor.setStyleForNextShapes(DefaultSizeStyle, defaults.size);
    }
    // DRW-207: unset → НЕ трогаем (статус-кво: нативный arc у ручных стрелок).
    if (defaults.arrowKind !== undefined) {
      setEcho("arrowKind", defaults.arrowKind);
      editor.setStyleForNextShapes(ArrowShapeKindStyle, defaults.arrowKind);
    }
  }

  // Initial fetch: board defaults → editor.
  void getStyleDefaults(space, room)
    .then((res) => {
      if (cancelled) return;
      roomDefaults = res.raw;
      if (res.raw) applyToEditor(res.raw);
    })
    .catch(() => {
      // Не валим UX — log only.
      // biome-ignore lint/suspicious/noConsole: best-effort fetch
      console.warn("[style-defaults-sync] initial fetch failed");
    });

  // Editor → server: подписка на изменения instance.stylesForNextShape от user.
  // source:"user" → WS-применённые правки пропускаются (mergeRemoteChanges
  // ставит source:"remote"), значит loop через server-push исключён.
  const unsubscribeListen = editor.store.listen(
    (entry) => {
      const updated = entry.changes.updated as Record<string, unknown>;
      for (const tuple of Object.values(updated)) {
        if (!Array.isArray(tuple) || tuple.length < 2) continue;
        const next = tuple[1] as { typeName?: string } & Record<string, unknown>;
        if (next.typeName !== "instance") continue;
        const styles =
          (next.stylesForNextShape as Record<string, unknown> | undefined) ?? {};

        const patch: StyleDefaults = {};
        let changed = false;

        const dashRaw = styles[DefaultDashStyle.id];
        if (isStyleDash(dashRaw)) {
          if (!checkEcho("dash", dashRaw) && roomDefaults?.dash !== dashRaw) {
            patch.dash = dashRaw;
            changed = true;
          }
        }
        const fontRaw = styles[DefaultFontStyle.id];
        if (isStyleFont(fontRaw)) {
          if (!checkEcho("font", fontRaw) && roomDefaults?.font !== fontRaw) {
            patch.font = fontRaw;
            changed = true;
          }
        }
        const sizeRaw = styles[DefaultSizeStyle.id];
        if (isStyleSize(sizeRaw)) {
          if (!checkEcho("size", sizeRaw) && roomDefaults?.size !== sizeRaw) {
            patch.size = sizeRaw;
            changed = true;
          }
        }
        // DRW-207: выбор kind в нативной style-панели стрелок → board default
        // (паритет с dash/font/size — bidirectional sync).
        const kindRaw = styles[ArrowShapeKindStyle.id];
        if (isArrowKind(kindRaw)) {
          if (
            !checkEcho("arrowKind", kindRaw) &&
            roomDefaults?.arrowKind !== kindRaw
          ) {
            patch.arrowKind = kindRaw;
            changed = true;
          }
        }

        if (changed) {
          const merged: StyleDefaults = { ...(roomDefaults ?? {}), ...patch };
          roomDefaults = merged;
          void postStyleDefaults(space, room, merged).catch(() => {
            // biome-ignore lint/suspicious/noConsole: best-effort write
            console.warn("[style-defaults-sync] persist failed");
          });
        }
      }
    },
    { source: "user", scope: "session" },
  );

  // Container resolution chain — при создании shape walk parent chain.
  // sideEffects.registerBeforeCreateHandler NOT triggered для mergeRemoteChanges
  // (per tldraw store docs), поэтому WS-applied shapes bypass этот резолвер,
  // что соответствует spec'у: AI/WS приходит уже с готовыми props.
  // Резолвер работает ТОЛЬКО если есть sticky meta в chain (board-level defaults
  // уже применены через setStyleForNextShapes echo; не перетираем user choice).
  const beforeCreateDisposer = editor.sideEffects.registerBeforeCreateHandler(
    "shape",
    (shape) => {
      const parentId = (shape as { parentId?: string }).parentId;
      const chain = buildResolutionChain(editor, parentId);
      if (chain.length === 0) return shape;
      // Merge chain в partial, nearest-first precedence.
      const partial: StyleDefaults = {};
      for (const layer of chain) {
        if (partial.dash === undefined && layer.dash !== undefined) partial.dash = layer.dash;
        if (partial.font === undefined && layer.font !== undefined) partial.font = layer.font;
        if (partial.size === undefined && layer.size !== undefined) partial.size = layer.size;
      }
      return applyPartialToShape(shape, partial);
    },
  );

  return () => {
    cancelled = true;
    unsubscribeListen();
    beforeCreateDisposer();
  };
}
