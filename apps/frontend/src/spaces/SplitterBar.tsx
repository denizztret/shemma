import { useCallback, useEffect, useRef } from "react";

/**
 * Vertical drag handle between two flex columns.
 *
 * Emits incremental `deltaPercent` (signed, relative to the parent flex
 * container width) as the user drags. The parent `MultiColumnLayout` owns
 * the width state and clamps + persists it.
 *
 * Listeners are attached to `document` on mousedown and detached on mouseup
 * so the drag keeps firing even when the cursor leaves the slim handle.
 */
export function SplitterBar({ onResize }: { onResize: (deltaPercent: number) => void }) {
  const startXRef = useRef<number | null>(null);
  const containerWidthRef = useRef<number>(0);
  // Keep the latest callback in a ref so the listeners we attach in
  // `onMouseDown` always see the current `onResize` without re-binding.
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (startXRef.current === null || containerWidthRef.current <= 0) return;
    const deltaPx = e.clientX - startXRef.current;
    const deltaPercent = (deltaPx / containerWidthRef.current) * 100;
    // Update anchor so the next move reports an incremental delta — the
    // parent layout accumulates these into the column widths.
    startXRef.current = e.clientX;
    onResizeRef.current(deltaPercent);
  }, []);

  const onMouseUp = useCallback(() => {
    startXRef.current = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      // Width of the flex *container* (parent of this splitter) determines
      // how many CSS percent a pixel delta represents. Fall back to 1 to
      // avoid division by zero in degenerate cases.
      const container = e.currentTarget.parentElement;
      containerWidthRef.current = container?.clientWidth ?? 1;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [onMouseMove, onMouseUp],
  );

  // Defensive: clean up listeners if the splitter unmounts mid-drag.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div
      className="splitter-bar"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
