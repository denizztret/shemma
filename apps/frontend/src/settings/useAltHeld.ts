import { useEffect, useState } from "react";

/**
 * Reactive "is the Opt/Alt key currently held" flag. Used by the settings panel
 * to live-swap labels/highlighting while Opt is down (Упорядочить→Принудительно;
 * pin header objects→frame/container). Passive listeners (setState only) — they
 * don't preventDefault, so they don't interfere with the Opt+click handlers.
 */
export function useAltHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setHeld(e.altKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    // Reset if focus leaves the window while Opt is held (keyup may be missed).
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}
