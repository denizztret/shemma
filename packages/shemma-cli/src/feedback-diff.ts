// packages/shemma-cli/src/feedback-diff.ts
//
// DRW-227.03: read-only reader for the feedback JSONL (DRW-227.01/.02). Pure
// join + format helpers — no analytics, no dashboards, no task creation. The
// CLI command (`shemma feedback --diff <room>`) reads a file and prints these.
//
// Types are structural on purpose (records are parsed from disk, written by the
// daemon) — the CLI does not import backend types.

export type FeedbackRecord = {
  kind?: string;
  ts?: string;
  route?: string;
  method?: string;
  clientOpId?: string | null;
  ok?: boolean;
  errorCode?: string | null;
  phase?: string | null;
  text?: string;
};

/** Parse JSONL text into records, skipping blank and malformed lines. */
export function parseFeedbackLines(text: string): FeedbackRecord[] {
  const out: FeedbackRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const rec = JSON.parse(trimmed) as unknown;
      if (rec && typeof rec === "object") out.push(rec as FeedbackRecord);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export type DiffEntry = {
  annotation: FeedbackRecord;
  request: FeedbackRecord | null;
  joinedBy: "clientOpId" | "timeline" | "none";
  /** A "blocker" note whose joined request actually succeeded — the classic
   *  agent misdiagnosis (thought it failed; the server said ok). */
  suspectedMisdiagnosis: boolean;
};

/**
 * Pair every annotation with the request it refers to: exact match by
 * `clientOpId`, else the nearest preceding request by timestamp. Pure.
 */
export function computeDiff(records: FeedbackRecord[]): DiffEntry[] {
  const requests = records.filter((r) => r.kind === "request");
  const byOpId = new Map<string, FeedbackRecord>();
  for (const r of requests) {
    if (typeof r.clientOpId === "string") byOpId.set(r.clientOpId, r);
  }

  const entries: DiffEntry[] = [];
  for (const ann of records) {
    if (ann.kind !== "annotation") continue;

    let request: FeedbackRecord | null = null;
    let joinedBy: DiffEntry["joinedBy"] = "none";

    if (typeof ann.clientOpId === "string" && byOpId.has(ann.clientOpId)) {
      request = byOpId.get(ann.clientOpId) ?? null;
      joinedBy = "clientOpId";
    } else {
      // nearest preceding request by timestamp
      const annTs = ann.ts ?? "";
      let best: FeedbackRecord | null = null;
      for (const r of requests) {
        const rTs = r.ts ?? "";
        if (rTs <= annTs && (best === null || rTs > (best.ts ?? ""))) best = r;
      }
      if (best) {
        request = best;
        joinedBy = "timeline";
      }
    }

    const suspectedMisdiagnosis =
      ann.phase === "blocker" && request?.ok === true;

    entries.push({ annotation: ann, request, joinedBy, suspectedMisdiagnosis });
  }
  return entries;
}

/** Render the diff entries as readable text for the terminal. */
export function formatDiff(entries: DiffEntry[]): string {
  if (entries.length === 0) {
    return "no annotations in this room's feedback log.";
  }
  const lines: string[] = [];
  for (const e of entries) {
    const a = e.annotation;
    const phase = a.phase ? `[${a.phase}] ` : "";
    lines.push(`${phase}"${a.text ?? ""}"`);
    if (e.request) {
      const r = e.request;
      const ok = r.ok === true ? "ok" : "FAIL";
      const code = r.errorCode ? ` errorCode=${r.errorCode}` : "";
      lines.push(
        `  → ${r.method ?? "?"} ${r.route ?? "?"}  ${ok}${code}  (joined by ${e.joinedBy})`,
      );
    } else {
      lines.push("  → (no matching request)");
    }
    if (e.suspectedMisdiagnosis) {
      lines.push(
        "  ⚠ possible misdiagnosis: reported a blocker but the call actually succeeded",
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
