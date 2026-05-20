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

// DRW-083: append-only by design. AI must never wipe existing canvas state —
// preserving user's manual layout edits is a hard product invariant. If a
// full-replace flow is ever needed, it ships as a separate `shemma_clear_room`
// tool that requires explicit user confirmation, not a hidden mode flag.
// DRW-088: selection-aware layout tool.
// ids — список tldraw shape id'ов ("shape:xxx") или didrawNames.
// Пустой ids === все shapes → полный layout (эквивалент shemma_layout).
export const LayoutSelectionArgs = {
  ids: z.array(z.string()).optional(),
  mode: LayoutModeEnum.optional(),
  spacing: SpacingEnum.optional(),
  room: z.string().optional(),
};

export const ImportMermaidArgs = {
  source: z.string().min(1),
  room: z.string().optional(),
  clientOpId: z.string().optional(),
  /**
   * DRW-086: Viewport behavior after a successful import.
   * - "new"     — zoom to the bounding box of the newly created shapes (default).
   * - "fit-all" — zoom to fit all shapes on the canvas.
   * - "none"    — do not change the viewport.
   */
  focus: z.enum(["new", "fit-all", "none"]).optional(),
};

// DRW-103: Miro export MCP tool args.
export const ExportMiroArgs = {
  boardId: z
    .string()
    .min(1)
    .describe(
      "Miro board id. If omitted, the last-used board (from room.meta.miroExports) " +
      "is used. If no tracking — returns error asking to specify boardId.",
    )
    .optional(),
  boardName: z.string().optional().describe("Display name cached for tracking."),
  selection: z
    .array(z.string())
    .optional()
    .describe(
      "Explicit list of element ids ('shape:...') to export. Empty/omitted with " +
      "scope='selection' returns an error (call this with the user's visual " +
      "selection from the canvas).",
    ),
  scope: z
    .enum(["selection", "room"])
    .default("selection")
    .describe(
      "'selection' (default) — uses the `selection` array. " +
      "'room' — exports all shapes in the room (ignores `selection`).",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "If true — returns preview JSON without making Miro API calls.",
    ),
  room: z.string().optional().describe("Room id (resolved via resolver chain when omitted)."),
};
