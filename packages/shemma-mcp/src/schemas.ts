import { z } from "zod";
import { ALL_ROLES, ALL_KINDS, ALL_MODES, ALL_SPACINGS } from "@shemma/domain";

// Zod enums built from canonical @shemma/domain constants — no local redeclaration.
export const RoleEnum = z.enum([...ALL_ROLES] as [string, ...string[]]);
export const ConnectionKindEnum = z.enum([...ALL_KINDS] as [string, ...string[]]);
export const LayoutModeEnum = z.enum([...ALL_MODES] as [string, ...string[]]);
export const SpacingEnum = z.enum([...ALL_SPACINGS] as [string, ...string[]]);

export const LayoutHintSchema = z
  .object({
    mode: LayoutModeEnum.optional(),
    scope: z.union([z.literal("all"), z.literal("affected"), z.string()]).optional(),
    spacing: SpacingEnum.optional(),
  })
  .nullable()
  .optional();

export const CommonWriteArgs = {
  room: z.string().optional(),
  clientOpId: z.string().optional(),
  dryRun: z.boolean().optional(),
  layoutHint: LayoutHintSchema,
};

export const DefineArgs = {
  ...CommonWriteArgs,
  name: z.string().min(1),
  role: RoleEnum,
  label: z.string().optional(),
};

export const ConnectArgs = {
  ...CommonWriteArgs,
  from: z.string().min(1),
  to: z.string().min(1),
  connectionKind: ConnectionKindEnum,
  label: z.string().optional(),
};

export const GroupArgs = {
  ...CommonWriteArgs,
  name: z.string().min(1),
  label: z.string().optional(),
  children: z.array(z.string().min(1)).min(1),
  // DRW-072: domain validator требует as in {network, boundary} (container role).
  // Раньше MCP wrapper не пробрасывал это поле, и любой shemma_group падал
  // c "group.as must be network|boundary". Default 'boundary' = sealed container
  // вокруг children; 'network' = виртуальная сеть (visual only). Default chosen
  // как наиболее distinctive в большинстве архитектурных схем.
  as: z.enum(["network", "boundary"]).optional(),
};

export const NoteArgs = {
  ...CommonWriteArgs,
  name: z.string().min(1),
  text: z.string(),
};

export const LayoutArgs = {
  ...CommonWriteArgs,
  mode: LayoutModeEnum.optional(),
  scope: z.union([z.literal("all"), z.literal("affected"), z.string()]).optional(),
  spacing: SpacingEnum.optional(),
};

export const DeleteArgs = {
  ...CommonWriteArgs,
  ids: z.array(z.string().min(1)).min(1),
  cascade: z.boolean().optional(),
};

export const ApplyArgs = {
  ...CommonWriteArgs,
  actions: z.array(z.record(z.unknown())).min(1),
};
