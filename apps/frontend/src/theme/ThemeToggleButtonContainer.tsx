// apps/frontend/src/theme/ThemeToggleButtonContainer.tsx
//
// DRW-230: wiring for the theme toggle. Subscribes to the theme store +
// tracks the Opt/Alt key, then renders the pure ThemeToggleButton. Isolated
// from App so the Opt-key re-render doesn't re-render the whole board chrome.

import type { FC } from "react";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { useAltKeyHeld } from "./useAltKeyHeld";
import { useThemeMode } from "./useThemeMode";

export const ThemeToggleButtonContainer: FC = () => {
  const { mode, colorMode, setMode } = useThemeMode();
  const altHeld = useAltKeyHeld();
  return (
    <ThemeToggleButton
      mode={mode}
      colorMode={colorMode}
      altHeld={altHeld}
      onSelect={setMode}
    />
  );
};
