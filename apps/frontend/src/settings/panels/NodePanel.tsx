import type { Role } from "@shemma/domain";
// apps/frontend/src/settings/panels/NodePanel.tsx
import type { FC } from "react";
import { LockedNotice } from "../sections/LockSection";
import { PinSection, type PinTriState } from "../sections/PinSection";
import { RoleSection } from "../sections/RoleSection";

export type NodePanelProps = {
  pinValues: { size: PinTriState; position: PinTriState };
  onPinToggle: (
    field: "size" | "position",
    modifiers: { alt: boolean },
  ) => void;
  role: Role | null;
  onRoleSelect: (role: Role) => void;
  /** Node sits inside a locked frame → collapse to «Разблокировать». */
  lockedFrame?: boolean;
  onUnlockFrame?: () => void;
};

export const NodePanel: FC<NodePanelProps> = ({
  pinValues,
  onPinToggle,
  role,
  onRoleSelect,
  lockedFrame,
  onUnlockFrame,
}) => (
  <div
    className="settings-popover__panel"
    role="dialog"
    aria-label="Настройки узла"
  >
    {lockedFrame && onUnlockFrame ? (
      <LockedNotice onUnlock={onUnlockFrame} />
    ) : (
      <>
        <PinSection values={pinValues} onToggle={onPinToggle} />
        <RoleSection current={role} onSelect={onRoleSelect} />
      </>
    )}
  </div>
);
