/** NodeId внутри schema-frame. Формат: `<slug>-<Nchar-base36>` или `e-<Nchar>` (anonymous).
 * Детально: см. spec §Identity format formal (DRW-134). */
export type NodeId = string;

export const SUFFIX_LENGTH_MIN = 3;
export const SUFFIX_LENGTH_MAX = 12;
export const DEFAULT_SUFFIX_LENGTH = 6;

/** Slug normalization per spec §Identity format formal:
 *  1) lowercase, 2) [^a-z0-9]+ → '-', 3) trim leading/trailing '-',
 *  4) slice 40 chars, 5) fallback "shape" если результат empty. */
export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "shape"
  );
}

/** Regex для валидации NodeId с конкретным suffix-length N.
 *  Принимает `<slug>-<N>` или `e-<N>`.
 *  Slug: один или более сегментов `[a-z0-9]+` через дефис. */
export function nodeIdRegex(suffixLen: number): RegExp {
  return new RegExp(
    `^(?:[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{${suffixLen}}|e-[0-9a-z]{${suffixLen}})$`,
  );
}

/** Default regex для suffixLen=6. */
export const DEFAULT_NODE_ID_REGEX: RegExp = nodeIdRegex(DEFAULT_SUFFIX_LENGTH);

/** Генерирует случайный suffix длиной suffixLen в base36 ([0-9a-z]).
 *  @param rng — функция возвращающая [0,1); default Math.random (frontend);
 *               backend инжектирует crypto-based RNG (Task 1.2). */
export function generateSuffix(
  suffixLen: number,
  rng: () => number = Math.random,
): string {
  const BASE36_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < suffixLen; i++) {
    result += BASE36_CHARS[Math.floor(rng() * 36)];
  }
  return result;
}

/** Генерирует NodeId с retry × 8 при коллизии.
 *
 * Правила anonymous form (spec §Identity format formal):
 * - `slug === ""` → prefix `e` → `e-<Nchar>`
 * - `slug === "shape"` (fallback из slugify при пустом label) → `shape-<Nchar>`
 * - Любой другой slug → `<slug>-<Nchar>`
 *
 * @throws Error("nodeId-collision") если все 8 попыток коллидируют. */
export function generateNodeId(opts: {
  slug: string;
  suffixLen?: number;
  existingIds: ReadonlySet<NodeId>;
  rng?: () => number;
}): NodeId {
  const { slug, existingIds, rng = Math.random } = opts;
  const suffixLen = opts.suffixLen ?? DEFAULT_SUFFIX_LENGTH;
  const prefix = slug === "" ? "e" : slug;

  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = generateSuffix(suffixLen, rng);
    const id: NodeId = `${prefix}-${suffix}`;
    if (!existingIds.has(id)) {
      return id;
    }
  }

  throw new Error("nodeId-collision");
}

/** Валидирует NodeId по regex с указанным suffixLen (default 6). */
export function isValidNodeId(
  id: string,
  suffixLen: number = DEFAULT_SUFFIX_LENGTH,
): boolean {
  return nodeIdRegex(suffixLen).test(id);
}
