import { Fragment, useCallback, useState } from "react";
import { App } from "../App";
import { Gallery } from "../gallery/Gallery";
import { SplitterBar } from "./SplitterBar";
import type { Column } from "./url-parser";

/**
 * Multi-column layout for DRW-116 (Task 17).
 *
 * Renders 1..N columns side-by-side as flex children. Adjacent columns are
 * separated by a `<SplitterBar />` whose drag delta is applied to the
 * neighbouring pair (i, i+1). Column widths are persisted per layout-arity
 * in localStorage under `shemma.splitter.<N>`.
 *
 * Single-column case keeps the original behaviour from the Task 14 stub:
 * just render `<App />` / `<Gallery />` without any flex chrome / splitters,
 * so legacy `?space=` / `?space=&room=` URLs look identical to before.
 */
export function MultiColumnLayout({ columns }: { columns: Column[] }) {
  const [widths, setWidths] = usePersistedWidths(columns.length);
  const [activeIdx, setActiveIdx] = useState(0);

  const resize = useCallback(
    (i: number, deltaPercent: number) => {
      setWidths((prev) => {
        if (i < 0 || i + 1 >= prev.length) return prev;
        const left = prev[i];
        const right = prev[i + 1];
        if (left === undefined || right === undefined) return prev;
        const next = [...prev];
        const min = MIN_COLUMN_PERCENT;
        const sumPair = left + right;
        // Clamp so neither neighbour shrinks below the minimum while keeping
        // their summed share invariant (the splitter only redistributes
        // within the pair — other columns are untouched).
        const candidate = Math.min(
          sumPair - min,
          Math.max(min, left + deltaPercent),
        );
        next[i] = candidate;
        next[i + 1] = sumPair - candidate;
        return next;
      });
    },
    [setWidths],
  );

  return (
    <div className="multi-col">
      {columns.map((col, i) => (
        <Fragment key={`${columnKey(col)}-${i}`}>
          <div
            className={`col${activeIdx === i ? " active" : ""}`}
            style={columns.length > 1 ? { flexBasis: `${widths[i]}%` } : undefined}
            onClick={() => setActiveIdx(i)}
          >
            {col.kind === "room" ? (
              <App space={col.spaceId} room={col.roomId} />
            ) : (
              <Gallery space={col.spaceId} />
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

function columnKey(col: Column): string {
  return col.kind === "room" ? `${col.spaceId}:${col.roomId}` : col.spaceId;
}

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
