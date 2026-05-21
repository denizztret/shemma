export type SpaceId = string;
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type SpaceStorageLayout = "project" | "legacy" | "direct";
export type Profile = "release" | "dev" | "debug";

export type SpaceRecord = {
  id: SpaceId;
  path: string;
  storageLayout: SpaceStorageLayout;
  label?: string;
  createdAt: string;
  lastUsedAt: string;
  legacy?: boolean;
};

export type SpacesRegistryFile = {
  schemaVersion: 1;
  spaces: SpaceRecord[];
};

export type SpacePublicDTO = {
  id: SpaceId;
  label?: string;
  lastUsedAt: string;
  orphaned?: boolean;
};

export type SpaceLocalDTO = SpacePublicDTO & {
  path: string;
  storageLayout: SpaceStorageLayout;
  createdAt: string;
  legacy?: boolean;
};
