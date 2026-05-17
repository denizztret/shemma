export type Role =
  | "actor" | "service" | "datastore" | "queue"
  | "network" | "boundary" | "external" | "note";

const CONTAINER_ROLES: ReadonlySet<Role> = new Set(["network", "boundary"]);

export function isContainerRole(r: Role): boolean {
  return CONTAINER_ROLES.has(r);
}

export const ALL_ROLES: readonly Role[] = [
  "actor", "service", "datastore", "queue",
  "network", "boundary", "external", "note",
];

export function isValidRole(s: string): s is Role {
  return (ALL_ROLES as readonly string[]).includes(s);
}
