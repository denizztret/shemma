// apps/frontend/src/settings/sections/RoleSection.tsx
import type { FC } from "react";
import { ALL_ROLES, type Role } from "@shemma/domain";

const ROLE_LABELS: Record<Role, string> = {
  actor: "Актор",
  service: "Сервис",
  datastore: "Хранилище",
  queue: "Очередь",
  network: "Сеть",
  boundary: "Граница",
  external: "Внешний",
  note: "Заметка",
};

const ROLE_HINTS: Record<Role, string> = {
  actor: "Человек или внешняя система, инициирующая взаимодействие",
  service: "Бизнес-сервис или приложение",
  datastore: "БД, кэш, файловое хранилище",
  queue: "Очередь сообщений, шина событий",
  network: "Сетевой узел, балансировщик, gateway",
  boundary: "Контекстная граница (домен, контур, security boundary)",
  external: "Сторонний сервис вне зоны контроля",
  note: "Свободный комментарий-аннотация",
};

export type RoleSectionProps = {
  current: Role | null;
  onSelect: (role: Role) => void;
};

export const RoleSection: FC<RoleSectionProps> = ({ current, onSelect }) => (
  <div className="settings-section settings-section--role">
    <div className="settings-section__label">Роль</div>
    <div className="settings-section__row settings-section__row--wrap">
      {ALL_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={current === role}
          title={ROLE_HINTS[role]}
          onClick={() => onSelect(role)}
          className={`settings-btn${current === role ? " settings-btn--on" : ""}`}
        >
          {ROLE_LABELS[role]}
        </button>
      ))}
    </div>
  </div>
);
