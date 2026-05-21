import { Fragment, useCallback, useEffect, useState } from "react";
import { App } from "../App";
import { Gallery } from "../gallery/Gallery";
import { SplitterBar } from "./SplitterBar";
import { applyBackToGallery, applyOpenRoom } from "./column-transitions";
import { type Column, parseShemmaUrl, serializeColumns } from "./url-parser";
import { applyResize } from "./widths";

/**
 * Multi-column layout for DRW-116 (Tasks 17 + 18).
 *
 * Renders 1..N columns side-by-side as flex children. Adjacent columns are
 * separated by a `<SplitterBar />` whose drag delta is applied to the
 * neighbouring pair (i, i+1). Column widths are persisted per layout-arity
 * in localStorage under `shemma.splitter.<N>`.
 *
 * Task 18 layered on top:
 *   • Internal `columns` state — initial value from the prop, then mutated by
 *     within-column transitions (gallery → room and back).
 *   • Each transition `pushState`s the new URL so the back/forward buttons
 *     return the user to the previous layout. A `popstate` listener
 *     re-parses the URL and resets local state in sync.
 *   • Gallery / App are wired with optional `onRoomOpen` / `onBackToGallery`
 *     callbacks so click handlers stay inside MultiColumnLayout rather than
 *     forcing a full-page `location.assign` like the legacy single-column
 *     path still does.
 *
 * Single-column case keeps the original behaviour from the Task 14 stub:
 * just render `<App />` / `<Gallery />` without any flex chrome / splitters,
 * so legacy `?space=` / `?space=&room=` URLs look identical to before.
 */
export function MultiColumnLayout({
  columns: initialColumns,
}: { columns: Column[] }) {
  const [columns, setColumns] = useState<Column[]>(initialColumns);
  const [widths, setWidths] = usePersistedWidths(columns.length);
  const [activeIdx, setActiveIdx] = useState(0);

  // Browser back/forward — re-parse the URL and re-hydrate columns state.
  // Landing view (no `space`/`cols` params) is unreachable from inside the
  // layout (the user must navigate there explicitly), so we only act on the
  // "columns" branch here.
  useEffect(() => {
    const onPop = () => {
      const state = parseShemmaUrl(window.location.href);
      if (state.view === "columns") {
        setColumns(state.columns);
        setActiveIdx((idx) => Math.min(idx, state.columns.length - 1));
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const updateColumns = useCallback((next: Column[]) => {
    setColumns(next);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", serializeColumns(next));
    }
  }, []);

  const openRoomInColumn = useCallback(
    (i: number, roomId: string) => {
      const next = applyOpenRoom(columns, i, roomId);
      if (next === columns) return;
      updateColumns(next);
      setActiveIdx(i);
    },
    [columns, updateColumns],
  );

  const backToGalleryInColumn = useCallback(
    (i: number) => {
      const next = applyBackToGallery(columns, i);
      if (next === columns) return;
      updateColumns(next);
      setActiveIdx(i);
    },
    [columns, updateColumns],
  );

  const resize = useCallback(
    (i: number, deltaPercent: number) => {
      setWidths((prev) => applyResize(prev, i, deltaPercent, MIN_COLUMN_PERCENT));
    },
    [setWidths],
  );

  return (
    <div className="multi-col">
      {columns.map((col, i) => (
        <Fragment key={`${col.spaceId}-${i}`}>
          <div
            className={`col${activeIdx === i ? " active" : ""}`}
            style={columns.length > 1 ? { flexBasis: `${widths[i]}%` } : undefined}
            onClick={() => setActiveIdx(i)}
          >
            {col.kind === "room" ? (
              <App
                space={col.spaceId}
                room={col.roomId}
                onBackToGallery={() => backToGalleryInColumn(i)}
              />
            ) : (
              <Gallery
                space={col.spaceId}
                onRoomOpen={(roomId) => openRoomInColumn(i, roomId)}
              />
            )}
          </div>
          {i < columns.length - 1 && (
            <SplitterBar onResize={(delta) => resize(i, delta)} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

const MIN_COLUMN_PERCENT = 10;

/**
 * Persist column widths per layout-arity. We key by `N` so 2- and 3-column
 * layouts each keep their own preferred split without clobbering the other.
 *
 * SSR-safe: when `window` is unavailable we just return the even split and
 * skip persistence — this also covers the bun-test env which doesn't have
 * a real localStorage in some runners.
 */
function usePersistedWidths(
  n: number,
): [number[], (updater: number[] | ((prev: number[]) => number[])) => void] {
  const key = `shemma.splitter.${n}`;
  const [widths, setWidthsRaw] = useState<number[]>(() => readWidths(key, n));

  const setWidths = useCallback(
    (updater: number[] | ((prev: number[]) => number[])) => {
      setWidthsRaw((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(key, JSON.stringify(next));
          } catch {
            // Ignore: localStorage quota / disabled. Widths still live in
            // component state for the current session.
          }
        }
        return next;
      });
    },
    [key],
  );

  return [widths, setWidths];
}

function readWidths(key: string, n: number): number[] {
  const evenSplit = Array.from({ length: n }, () => 100 / n);
  if (typeof window === "undefined") return evenSplit;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return evenSplit;
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === n &&
      parsed.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)
    ) {
      return parsed;
    }
  } catch {
    // Corrupt JSON — fall through to even split.
  }
  return evenSplit;
}
