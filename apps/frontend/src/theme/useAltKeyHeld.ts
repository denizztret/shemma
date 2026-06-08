// apps/frontend/src/theme/useAltKeyHeld.ts
//
// DRW-230: tracks whether the Opt/Alt key is currently held, so the theme
// toggle can preview/select "system" on Opt-click. Window-level listeners;
// reads `e.altKey` (the real modifier state) on both keydown and keyup, and
// resets on blur so a held Opt doesn't get stuck when focus leaves the page.

import { useEffect, useState } from "react";

export function useAltKeyHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setHeld(e.altKey);
    const onBlur = () => setHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return held;
}
