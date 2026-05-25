/**
 * Bespoke storage-mode mermaid parser (Option A, zero deps).
 *
 * Покрывает subset per spec §Mermaid → schema action mapping (DRW-134):
 *  - graph TD|LR|TB|BT|RL
 *  - flowchart TD|LR|TB|BT|RL
 *  - Node shapes: rect/round/diamond/cylinder/stadium/hex/subroutine/asymmetric
 *  - Edges: -->, -.->, ==>, --x, --o, -->|label|, --text-->
 *  - subgraph id [Label] ... end (nested OK)
 *  - Frontmatter (--- title: ... ---) stripped before parse
 *  - Comments (%%) stripped
 *
 * Unsupported diagram types (sequenceDiagram, classDiagram, gitGraph, etc.) →
 *   { ok: false, code: "unsupported-diagram-type" }.
 *
 * NO DOM, NO mermaid.parse() — pure Node regex-driven parsing.
 */

import type {
  SchemaAction,
  SchemaGroupAction,
  SchemaConnectAction,
  SchemaDefineAction,
} from "@shemma/domain";
import type { NodeId } from "@shemma/domain";
import type { Role } from "@shemma/domain";
import type { ConnectionKind } from "@shemma/domain";

export type MermaidDirection = "TD" | "LR" | "TB" | "BT" | "RL";

/**
 * Parsed mermaid `style NAME prop:val,...` directives for a single node/subgraph.
 * Keys from mermaid CSS-like style string; all optional (partial application OK).
 */
export type MermaidNodeStyle = {
  fill?: string;
  stroke?: string;
  color?: string;
  /** Stored as-is if present; not applied to tldraw (phase 2 follow-up). */
  strokeWidth?: string;
  /** Stored as-is if present; not applied to tldraw (phase 2 follow-up). */
  strokeDasharray?: string;
};

export type ParseResult =
  | {
      ok: true;
      actions: SchemaAction[];
      direction: MermaidDirection;
      /** Parsed `style NAME ...` directives — keyed by raw mermaid identifier. */
      nodeStyles: Map<string, MermaidNodeStyle>;
      /**
       * Same data as `nodeStyles` but keyed by resolved NodeId (for easy lookup in schema.ts).
       * Only includes nodes that appear in both a node/edge line and a style directive.
       */
      nodeStylesByNodeId: Map<NodeId, MermaidNodeStyle>;
      /**
       * Parsed `style NAME ...` directives for subgraph boundaries — keyed by subgraph mermaid id (slug).
       * Populated only for identifiers that appeared in a `subgraph X[...]` header at parse time.
       * NOTE: if a `style X ...` directive appears BEFORE the `subgraph X[...]` line in source,
       * it will NOT be captured here (classified as leaf node style instead). MVP limitation.
       */
      subgraphStyles: Map<string, MermaidNodeStyle>;
    }
  | {
      ok: false;
      code: "invalid-mermaid" | "unsupported-diagram-type";
      message: string;
      /** Detected diagram type for unsupported-diagram-type errors. */
      detectedType?: string;
    };

/** Known unsupported diagram types per spec §Out of scope. */
const UNSUPPORTED_DIAGRAM_KEYWORDS: readonly string[] = [
  "sequenceDiagram",
  "classDiagram",
  "gitGraph",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "stateDiagram",
  "stateDiagram-v2",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "quadrantChart",
  "requirementDiagram",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "kanban",
  "architecture-beta",
];

/** Supported flowchart/graph directions. */
const VALID_DIRECTIONS: readonly MermaidDirection[] = [
  "TD",
  "LR",
  "TB",
  "BT",
  "RL",
];

/**
 * Parse mermaid flowchart/graph subset → SchemaAction[].
 *
 * @param raw       - raw mermaid string
 * @param opts.suffixLen    - node id suffix length (from room.meta, default 6)
 * @param opts.existingIds  - pre-existing IDs for collision avoidance
 * @param opts.generateId   - injected ID generator (for test determinism)
 */
export function parseMermaidFlowchart(
  raw: string,
  opts: {
    suffixLen: number;
    existingIds?: ReadonlySet<NodeId>;
    /**
     * ID generator callback.
     * @param slug       - normalized slug from label (or mermaid id if no label)
     * @param existing   - set of already-used NodeIds (for collision avoidance)
     * @param mermaidId  - raw mermaid identifier from diagram (e.g. "api-aaaaaa")
     *                     For storage-mode RAW, this IS the NodeId; callback can return it directly.
     */
    generateId: (slug: string, existing: ReadonlySet<NodeId>, mermaidId: string) => NodeId;
  },
): ParseResult {
  const { generateId } = opts;
  const existingIds: ReadonlySet<NodeId> = opts.existingIds ?? new Set<NodeId>();

  // --- Strip YAML frontmatter (--- ... ---) ---
  let src = raw.trim();
  if (src.startsWith("---")) {
    const endIdx = src.indexOf("\n---", 3);
    if (endIdx !== -1) {
      src = src.slice(endIdx + 4).trim();
    }
  }

  // DRW-155: collapse newlines inside double-quoted strings into spaces.
  // Mermaid labels (e.g. `A["multi\nline"]`) are visually multi-line in the
  // editor but logically one token; line-by-line split would otherwise treat
  // continuation lines as garbage. Single-quotes are not treated as label
  // delimiters in our subset.
  src = collapseQuotedNewlines(src);

  // Split into lines, strip comments (%%) and blank lines
  const lines = src
    .split("\n")
    .map((l) => l.replace(/%%.*$/, "").trimEnd())
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { ok: false, code: "invalid-mermaid", message: "Empty diagram" };
  }

  // --- Check for unsupported diagram types ---
  const firstLine = (lines[0] ?? "").trim();
  for (const keyword of UNSUPPORTED_DIAGRAM_KEYWORDS) {
    if (firstLine.startsWith(keyword)) {
      return {
        ok: false,
        code: "unsupported-diagram-type",
        message: `Unsupported diagram type: ${keyword}. Only graph/flowchart subsets are supported.`,
        detectedType: keyword,
      };
    }
  }

  // --- Parse first line: graph/flowchart <DIRECTION> ---
  const headerMatch = firstLine.match(
    /^(?:graph|flowchart)\s+(TD|LR|TB|BT|RL)\s*(?:%%.*)?$/,
  );
  if (!headerMatch) {
    // If first line starts with graph/flowchart (case-insensitive), it's a malformed
    // graph header (wrong/missing direction) → invalid-mermaid, not unsupported type.
    if (/^(?:graph|flowchart)(?:\s|$)/i.test(firstLine)) {
      return {
        ok: false,
        code: "invalid-mermaid",
        message: `Invalid or missing direction in: "${firstLine}". Expected one of: ${VALID_DIRECTIONS.join(", ")}`,
      };
    }
    return {
      ok: false,
      code: "unsupported-diagram-type",
      message: `Unrecognized diagram header: "${firstLine}"`,
      detectedType: firstLine.split(/\s+/)[0],
    };
  }

  const direction = headerMatch[1] as MermaidDirection;

  // State for parsing
  /** Map: mermaid node identifier → generated NodeId */
  const idMap = new Map<string, NodeId>();
  /** All NodeId generated so far (for collision detection) */
  const allIds = new Set<NodeId>(existingIds);
  /** All SchemaActions accumulated */
  const actions: SchemaAction[] = [];
  /** Parsed style directives: mermaid id → style object (keyed by raw mermaid id). */
  const nodeStyles = new Map<string, MermaidNodeStyle>();
  /** Parsed style directives for subgraph boundaries — keyed by subgraph mermaid id. */
  const subgraphStyles = new Map<string, MermaidNodeStyle>();
  /** Set of mermaid ids that are subgraph identifiers (populated as subgraph headers are parsed). */
  const subgraphNames = new Set<string>();

  /** Stack of active subgraph contexts — for tracking nesting */
  const subgraphStack: Array<{
    mermaidId: string;
    label: string;
    children: NodeId[];
    /** direction line found inside this subgraph body, if any (normalized: TD→TB) */
    direction?: "TB" | "LR" | "BT" | "RL";
  }> = [];

  /** Inline slugify (mirrors @shemma/domain identity.ts:slugify) */
  function slugify(label: string): string {
    return (
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "shape"
    );
  }

  /** Resolve or generate a NodeId for a mermaid identifier + optional label */
  function resolveNodeId(mermaidId: string, label?: string): NodeId {
    const existing = idMap.get(mermaidId);
    if (existing !== undefined) return existing;
    // slug from label if given, else from mermaid id itself
    const effectiveLabel = label !== undefined ? label : mermaidId;
    const slug =
      effectiveLabel === "" ? "" : slugify(effectiveLabel);
    const nodeId = generateId(slug, allIds, mermaidId);
    idMap.set(mermaidId, nodeId);
    allIds.add(nodeId);
    return nodeId;
  }

  // --- Process lines 1..N ---
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();

    if (!line) continue;

    // ---- subgraph start ----
    // subgraph id [Label]   OR   subgraph id
    const subgraphMatch = line.match(
      /^subgraph\s+(\S+?)(?:\s*\[([^\]]*)\])?\s*$/,
    );
    if (subgraphMatch) {
      const sgMermaidId = subgraphMatch[1] ?? "";
      const rawSgLabel = subgraphMatch[2];
      // DRW-150 W1: strip surrounding quotes from label here in parser, not in factory.
      // e.g. subgraph INPUT["Вход"] → rawSgLabel = '"Вход"' → sgLabel = 'Вход'
      const sgLabelRaw =
        rawSgLabel !== undefined ? rawSgLabel.trim() : sgMermaidId;
      const sgLabel = sgLabelRaw.replace(/^["']|["']$/g, "");
      subgraphNames.add(sgMermaidId);
      subgraphStack.push({ mermaidId: sgMermaidId, label: sgLabel, children: [] });
      continue;
    }

    // ---- end (closes subgraph) ----
    if (line === "end") {
      if (subgraphStack.length > 0) {
        const sg = subgraphStack.pop();
        if (sg) {
          // Ensure the subgraph itself has a NodeId
          const sgNodeId = resolveNodeId(sg.mermaidId, sg.label);
          // Emit schema-group action
          // DRW-150 C1: include mermaidId so callsite can use it for subgraphStyles lookup.
          const groupAction: SchemaGroupAction = {
            kind: "schema-group",
            name: sgNodeId,
            label: sg.label,
            as: "boundary",
            nodeIds: sg.children,
            mermaidId: sg.mermaidId,
            ...(sg.direction !== undefined ? { direction: sg.direction } : {}),
          };
          actions.push(groupAction);
        }
      }
      continue;
    }

    // ---- direction override — record in innermost subgraph context ----
    const dirMatch = line.match(/^direction\s+(TD|LR|TB|BT|RL)\s*$/);
    if (dirMatch) {
      const rawDir = dirMatch[1] as "TD" | "LR" | "TB" | "BT" | "RL";
      // Normalize TD → TB (alias)
      const normalizedDir: "TB" | "LR" | "BT" | "RL" = rawDir === "TD" ? "TB" : rawDir;
      if (subgraphStack.length > 0) {
        const innermost = subgraphStack[subgraphStack.length - 1];
        if (innermost) {
          innermost.direction = normalizedDir;
        }
      }
      continue;
    }

    // ---- style directive: parse fill/stroke/color into nodeStyles ----
    // Syntax: style <nodeId> <prop>:<val>[,<prop>:<val>]*
    const styleDirectiveMatch = line.match(/^style\s+(\S+)\s+(.*)/);
    if (styleDirectiveMatch) {
      const styleToken = styleDirectiveMatch[1] as string;
      const styleStr = styleDirectiveMatch[2] as string;
      const parsed = parseMermaidStyleString(styleStr);
      if (parsed) {
        if (subgraphNames.has(styleToken)) {
          // Subgraph boundary style — stored separately for use in schema factory (Task 3)
          subgraphStyles.set(styleToken, parsed);
        } else {
          // Leaf node style — stored in nodeStyles as before
          nodeStyles.set(styleToken, parsed);
        }
      }
      continue;
    }

    // ---- classDef/class/linkStyle/click directives (skip) ----
    if (/^(?:classDef|class|linkStyle|click)\s/.test(line)) {
      continue;
    }

    // ---- Try to parse as edge chain or standalone node declaration ----
    const parseLineResult = parseLine(
      line,
      resolveNodeId,
      actions,
      subgraphStack,
    );
    if (!parseLineResult.ok) {
      return {
        ok: false,
        code: "invalid-mermaid",
        message: `Cannot parse line ${i + 1}: "${line}"`,
      };
    }
  }

  // Build nodeStylesByNodeId by resolving mermaid IDs → NodeIds via idMap.
  // Nodes referenced only in style directives (not in any edge/node line) won't be in idMap;
  // those entries are retained in nodeStyles (by mermaid ID) for completeness but
  // not included in nodeStylesByNodeId.
  const nodeStylesByNodeId = new Map<NodeId, MermaidNodeStyle>();
  for (const [mermaidId, style] of nodeStyles) {
    const nodeId = idMap.get(mermaidId);
    if (nodeId !== undefined) {
      nodeStylesByNodeId.set(nodeId, style);
    }
  }

  return { ok: true, actions, direction, nodeStyles, nodeStylesByNodeId, subgraphStyles };
}

// ---- Style string parsing ----

/**
 * Parse a mermaid CSS-like style string (e.g. `fill:#e3f2fd,stroke:#1565c0,color:#000`)
 * into a `MermaidNodeStyle` object.
 *
 * Returns `null` if the input is empty or contains no recognisable properties.
 * Individual unrecognised properties are silently skipped (graceful degradation).
 */
/**
 * Collapse newlines inside double-quoted strings into spaces.
 * Mermaid renderers tolerate multi-line labels like `A["line1\nline2"]`, but
 * our line-by-line parser would treat continuation lines as syntax errors.
 * State machine toggles `inQuote` on each unescaped `"` and replaces `\n`
 * with a single space while inside quotes.
 */
function collapseQuotedNewlines(src: string): string {
  let result = "";
  let inQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      inQuote = !inQuote;
      result += c;
      continue;
    }
    if (inQuote && c === "\n") {
      result += " ";
      continue;
    }
    result += c;
  }
  return result;
}

function parseMermaidStyleString(styleStr: string): MermaidNodeStyle | null {
  if (!styleStr || !styleStr.trim()) return null;

  const result: MermaidNodeStyle = {};
  // Split on commas not inside parens (mermaid style values are simple; no nested commas expected)
  const parts = styleStr.split(",");

  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue; // malformed entry — skip
    const key = part.slice(0, colonIdx).trim().toLowerCase();
    const value = part.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    switch (key) {
      case "fill":
        result.fill = value;
        break;
      case "stroke":
        result.stroke = value;
        break;
      case "color":
        result.color = value;
        break;
      case "stroke-width":
        result.strokeWidth = value;
        break;
      case "stroke-dasharray":
        result.strokeDasharray = value;
        break;
      default:
        // Unknown property — ignore (future extensibility)
        break;
    }
  }

  // Return null if nothing was parsed
  if (
    result.fill === undefined &&
    result.stroke === undefined &&
    result.color === undefined &&
    result.strokeWidth === undefined &&
    result.strokeDasharray === undefined
  ) {
    return null;
  }

  return result;
}

// ---- Node declaration parsing ----

type NodeDecl = { mermaidId: string; label: string; role: Role };

/**
 * Parse a node token (already extracted from line) into NodeDecl.
 * Returns null if the token doesn't match any known node syntax.
 */
function parseNodeDecl(token: string): NodeDecl | null {
  type PatternEntry = [RegExp, Role];
  // Ordered by specificity (most specific first)
  const PATTERNS: PatternEntry[] = [
    // Cylinder: id[(Label)]
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\[\(([^)]*)\)\]$/, "datastore"],
    // Circle/Actor: id((Label))
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\(\(([^)]*)\)\)$/, "actor"],
    // Hexagon: id{{Label}}
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\{\{([^}]*)\}\}$/, "service"],
    // Subroutine: id[[Label]]
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\[\[([^\]]*)\]\]$/, "service"],
    // Asymmetric/External: id>Label]
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)>([^\]]*)\]$/, "external"],
    // Diamond: id{Label}
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\{([^}]*)\}$/, "service"],
    // Stadium: id([Label])
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\(\[([^\]]*)\]\)$/, "service"],
    // Round-rect: id(Label)
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\(([^)]*)\)$/, "service"],
    // Quoted rect: id["Label"]
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\["([^"]*)"\]$/, "service"],
    // Quoted rect: id['Label']
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\['([^']*)'\]$/, "service"],
    // Rect: id[Label]
    [/^([A-Za-z0-9_][A-Za-z0-9_-]*)\[([^\]]*)\]$/, "service"],
  ];

  for (const [pattern, role] of PATTERNS) {
    const m = token.match(pattern);
    if (m) {
      return {
        mermaidId: m[1] as string,
        label: m[2] as string,
        role,
      };
    }
  }

  // Bare identifier (no shape syntax)
  const bareMatch = token.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*)$/);
  if (bareMatch) {
    return {
      mermaidId: bareMatch[1] as string,
      label: bareMatch[1] as string,
      role: "service",
    };
  }

  return null;
}

// ---- Edge parsing ----

type EdgeInfo = { connectionKind: ConnectionKind; label?: string };

/**
 * Try to match an edge pattern at the start of `input`.
 * Returns { edge, remaining } if matched, null otherwise.
 */
function matchEdge(
  input: string,
): { edge: EdgeInfo; remaining: string } | null {
  const s = input.trim();

  type EdgePattern = [RegExp, ConnectionKind];
  // Arrow with label: -->|label| or ---|label|
  let m = s.match(/^-->\s*\|([^|]*)\|\s*(.*)/s);
  if (m)
    return {
      edge: { connectionKind: "sync", label: (m[1] as string).trim() },
      remaining: m[2] as string,
    };

  m = s.match(/^---\s*\|([^|]*)\|\s*(.*)/s);
  if (m)
    return {
      edge: { connectionKind: "sync", label: (m[1] as string).trim() },
      remaining: m[2] as string,
    };

  // Text arrow: --text-->
  m = s.match(/^--([^->|][^->]*?)-->\s*(.*)/s);
  if (m)
    return {
      edge: { connectionKind: "sync", label: (m[1] as string).trim() },
      remaining: m[2] as string,
    };

  // Text link: --text---
  m = s.match(/^--([^->|][^->]*?)---\s*(.*)/s);
  if (m)
    return {
      edge: { connectionKind: "sync", label: (m[1] as string).trim() },
      remaining: m[2] as string,
    };

  // Cross: --x (async per spec)
  m = s.match(/^--x\s+(.*)/s);
  if (m) return { edge: { connectionKind: "async" }, remaining: m[1] as string };

  // Circle: --o (async per spec)
  m = s.match(/^--o\s+(.*)/s);
  if (m) return { edge: { connectionKind: "async" }, remaining: m[1] as string };

  // Dotted: -.->
  m = s.match(/^-\.->\s*(.*)/s);
  if (m) return { edge: { connectionKind: "dep" }, remaining: m[1] as string };

  // Thick: ==>
  m = s.match(/^==>\s*(.*)/s);
  if (m) return { edge: { connectionKind: "data" }, remaining: m[1] as string };

  // Normal: -->
  m = s.match(/^-->\s*(.*)/s);
  if (m) return { edge: { connectionKind: "sync" }, remaining: m[1] as string };

  // Open link: ---
  m = s.match(/^---\s*(.*)/s);
  if (m) return { edge: { connectionKind: "sync" }, remaining: m[1] as string };

  return null;
}

// ---- Node token extraction ----

/**
 * Extract the next node token from the start of `input`.
 * Returns { token, rest } where token is the raw node syntax string
 * and rest is the portion of input that follows.
 */
function extractNodeToken(
  input: string,
): { token: string; rest: string } | null {
  const s = input.trim();
  if (!s) return null;

  // Must start with a valid identifier char
  const idMatch = s.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*)/);
  if (!idMatch) return null;

  const id = idMatch[1] as string;
  const afterId = s.slice(id.length);

  if (!afterId || /^[\s\t]/.test(afterId)) {
    // Bare identifier — check next chars are edge syntax, end, or whitespace
    if (
      !afterId ||
      /^(?:\s|--|=|-\.|&|$)/.test(afterId)
    ) {
      return { token: id, rest: afterId };
    }
    return null;
  }

  // Try shaped patterns (ordered by specificity)
  type ShapePattern = [RegExp, (id: string, inner: string) => string];
  const SHAPE_PATTERNS: ShapePattern[] = [
    // id[(content)] — cylinder
    [/^\[\(([^)]*)\)\](.*)$/s, (i, c) => `${i}[(${c})]`],
    // id((content)) — circle
    [/^\(\(([^)]*)\)\)(.*)$/s, (i, c) => `${i}((${c}))`],
    // id{{content}} — hex
    [/^\{\{([^}]*)\}\}(.*)$/s, (i, c) => `${i}{{${c}}}`],
    // id[[content]] — subroutine
    [/^\[\[([^\]]*)\]\](.*)$/s, (i, c) => `${i}[[${c}]]`],
    // id([content]) — stadium
    [/^\(\[([^\]]*)\]\)(.*)$/s, (i, c) => `${i}([${c}])`],
    // id["content"] — quoted rect
    [/^\["([^"]*)"\](.*)$/s, (i, c) => `${i}["${c}"]`],
    // id['content'] — quoted rect
    [/^\['([^']*)'\](.*)$/s, (i, c) => `${i}['${c}']`],
    // id[content] — rect
    [/^\[([^\]]*)\](.*)$/s, (i, c) => `${i}[${c}]`],
    // id{content} — diamond
    [/^\{([^}]*)\}(.*)$/s, (i, c) => `${i}{${c}}`],
    // id(content) — round-rect
    [/^\(([^)]*)\)(.*)$/s, (i, c) => `${i}(${c})`],
    // id>content] — asymmetric
    [/^>([^\]]*)\](.*)$/s, (i, c) => `${i}>${c}]`],
  ];

  for (const [pattern, buildToken] of SHAPE_PATTERNS) {
    const m = afterId.match(pattern);
    if (m) {
      const inner = m[1] as string;
      const rest = m[2] as string;
      return { token: buildToken(id, inner), rest };
    }
  }

  // No shape syntax but character follows — check if it's edge syntax
  if (/^(?:--|=|-\.)/.test(afterId) || /^>/.test(afterId)) {
    // Could be edge syntax directly after bare id (no space)
    // e.g. "a-->b" — treat as bare id
    return { token: id, rest: afterId };
  }

  return null;
}

// ---- Line parsing ----

/** Emit a schema-define action if this node hasn't been defined yet. */
function ensureDefine(
  decl: NodeDecl,
  nodeId: NodeId,
  actions: SchemaAction[],
  subgraphStack: Array<{ mermaidId: string; label: string; children: NodeId[] }>,
): void {
  const alreadyDefined = actions.some(
    (a): a is SchemaDefineAction =>
      a.kind === "schema-define" && a.nodeId === nodeId,
  );
  if (!alreadyDefined) {
    // Emit a label only when label differs from the raw mermaid identifier
    // (bare id nodes: label === mermaidId → omit label field)
    const labelToEmit =
      decl.label !== decl.mermaidId ? decl.label : undefined;

    const defineAction: SchemaDefineAction = {
      kind: "schema-define",
      nodeId,
      role: decl.role,
      ...(labelToEmit !== undefined ? { label: labelToEmit } : {}),
    };
    actions.push(defineAction);
  }

  // Track as child of innermost subgraph, even if the node was previously defined
  // outside the subgraph. Mermaid allows referencing pre-defined nodes inside a
  // subgraph to declare membership (DRW-156).
  if (subgraphStack.length > 0) {
    const innermost = subgraphStack[subgraphStack.length - 1];
    if (innermost && !innermost.children.includes(nodeId)) {
      innermost.children.push(nodeId);
    }
  }
}

/**
 * Parse a single content line as: nodeToken [edgeToken nodeToken]*.
 * Handles chained edges (A --> B --> C).
 */
function parseLine(
  line: string,
  resolveNodeId: (mermaidId: string, label?: string) => NodeId,
  actions: SchemaAction[],
  subgraphStack: Array<{ mermaidId: string; label: string; children: NodeId[] }>,
): { ok: true } | { ok: false } {
  let remaining = line.trim();
  if (!remaining) return { ok: true };

  // Extract the first node token
  const lhsResult = extractNodeToken(remaining);
  if (!lhsResult) return { ok: false };

  const lhsDecl = parseNodeDecl(lhsResult.token);
  if (!lhsDecl) return { ok: false };

  remaining = lhsResult.rest.trim();

  const lhsNodeId = resolveNodeId(
    lhsDecl.mermaidId,
    lhsDecl.label !== lhsDecl.mermaidId ? lhsDecl.label : undefined,
  );
  ensureDefine(lhsDecl, lhsNodeId, actions, subgraphStack);

  // If nothing left, this was a standalone node declaration
  if (!remaining) return { ok: true };

  // Parse edge chain: LHS (edge RHS)+
  let currentNodeId = lhsNodeId;

  while (remaining.length > 0) {
    const edgeResult = matchEdge(remaining);
    if (!edgeResult) {
      // No edge found — remaining content not parseable
      return { ok: false };
    }

    remaining = edgeResult.remaining.trim();
    if (!remaining) return { ok: false }; // Edge with no RHS

    const rhsResult = extractNodeToken(remaining);
    if (!rhsResult) return { ok: false };

    const rhsDecl = parseNodeDecl(rhsResult.token);
    if (!rhsDecl) return { ok: false };

    remaining = rhsResult.rest.trim();

    const rhsNodeId = resolveNodeId(
      rhsDecl.mermaidId,
      rhsDecl.label !== rhsDecl.mermaidId ? rhsDecl.label : undefined,
    );
    ensureDefine(rhsDecl, rhsNodeId, actions, subgraphStack);

    const connectAction: SchemaConnectAction = {
      kind: "schema-connect",
      from: currentNodeId,
      to: rhsNodeId,
      connectionKind: edgeResult.edge.connectionKind,
      ...(edgeResult.edge.label !== undefined
        ? { label: edgeResult.edge.label }
        : {}),
    };
    actions.push(connectAction);

    // For chained edges: RHS becomes new LHS
    currentNodeId = rhsNodeId;
  }

  return { ok: true };
}
