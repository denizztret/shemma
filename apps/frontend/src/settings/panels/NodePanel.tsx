// apps/frontend/src/settings/panels/NodePanel.tsx
import type { FC } from "react";
import { PinSection } from "../sections/PinSection";
import { RoleSection } from "../sections/RoleSection";
import type { Role } from "@shemma/domain";

export type NodePanelProps = {
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  role: Role | null;
  onRoleSelect: (role: Role) => void;
};

export const NodePanel: FC<NodePanelProps> = ({ pinValues, onPinToggle, role, onRoleSelect }) => (
  <div className="settings-popover__panel" role="dialog" aria-label="Node settings">
    <PinSection values={pinValues} onToggle={onPinToggle} />
    <RoleSection current={role} onSelect={onRoleSelect} />
  </div>
);
