// apps/frontend/src/settings/sections/RoleSection.tsx
import type { FC } from "react";
import { ALL_ROLES, type Role } from "@shemma/domain";

export type RoleSectionProps = {
  current: Role | null;
  onSelect: (role: Role) => void;
};

export const RoleSection: FC<RoleSectionProps> = ({ current, onSelect }) => (
  <div className="settings-section settings-section--role">
    <div className="settings-section__label">Role</div>
    <div className="settings-section__row settings-section__row--wrap">
      {ALL_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={current === role}
          onClick={() => onSelect(role)}
          className={`settings-btn${current === role ? " settings-btn--on" : ""}`}
        >
          {role}
        </button>
      ))}
    </div>
  </div>
);
