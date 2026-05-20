// apps/frontend/src/canvas/export-miro-modal.tsx
//
// DRW-103: Export to Miro modal — three steps (board picker → confirm → result).
// Rendered as a child of tldraw's component slot (App.tsx hosts it in
// OverlayUi alongside PromptInput/MermaidImportModal). No position:fixed —
// follows §3.8 service-layer pattern.

import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";

export interface Board {
  id: string;
  name: string;
  viewLink?: string;
}

interface ExportResult {
  ok: boolean;
  boardId?: string;
  boardUrl?: string;
  itemsCreated?: number;
  connectorsCreated?: number;
  skipped?: Array<{ elementId: string; reason: string }>;
  error?: string;
  hint?: string;
}

export interface ExportMiroModalProps {
  open: boolean;
  room: string;
  /** Selection ids from the editor (raw "shape:..." ids). */
  selectedIds: string[];
  onClose: () => void;
}

type Phase = "loading" | "pick" | "confirm" | "exporting" | "result" | "error";

export function ExportMiroModal({
  open,
  room,
  selectedIds,
  onClose,
}: ExportMiroModalProps): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>("loading");
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  // Fetch boards on open
  useEffect(() => {
    if (!open) return;
    setPhase("loading");
    setErrorMsg(null);
    setErrorHint(null);
    fetch("/api/export/miro/boards")
      .then(async (r) => {
        const j = (await r.json()) as
          | { boards: Board[] }
          | { ok: false; error: string; hint?: string };
        if (r.status === 412 && "error" in j) {
          setErrorMsg(j.error);
          setErrorHint(j.hint ?? null);
          setPhase("error");
          return;
        }
        if ("boards" in j) {
          setBoards(j.boards);
          setSelectedBoardId(j.boards[0]?.id ?? null);
          setPhase("pick");
        } else {
          setErrorMsg("failed to load boards");
          setPhase("error");
        }
      })
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });
  }, [open]);

  if (!open) return null;

  async function runExport(): Promise<void> {
    if (!selectedBoardId) return;
    setPhase("exporting");
    try {
      const res = await fetch(`/api/export/miro?room=${encodeURIComponent(room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: selectedBoardId,
          boardName: boards.find((b) => b.id === selectedBoardId)?.name,
          selection: selectedIds,
          scope: "selection",
        }),
      });
      const j = (await res.json()) as ExportResult;
      setResult(j);
      setPhase("result");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const filteredBoards = search.length === 0
    ? boards
    : boards.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()));

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: tokens.color.bgOverlay,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    padding: 20,
    minWidth: 480,
    maxWidth: 640,
    zIndex: 1000,
    fontFamily: tokens.font.mono,
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
  };

  return (
    <div className="shemma-export-modal" style={containerStyle}>
      <h3 style={{ marginTop: 0, fontFamily: tokens.font.mono }}>Export to Miro</h3>

      {phase === "loading" && <div>Loading boards…</div>}

      {phase === "pick" && (
        <>
          <input
            type="text"
            placeholder="Search boards…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", padding: 6, marginBottom: 12, fontFamily: tokens.font.mono }}
          />
          <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 280, overflowY: "auto" }}>
            {filteredBoards.map((b) => (
              <li key={b.id} style={{ padding: "6px 0" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="board"
                    checked={selectedBoardId === b.id}
                    onChange={() => setSelectedBoardId(b.id)}
                  />
                  <span style={{ flex: 1 }}>{b.name}</span>
                  {b.viewLink && (
                    <a href={b.viewLink} target="_blank" rel="noreferrer" style={{ fontSize: tokens.font.sm }}>
                      Open ↗
                    </a>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              disabled={selectedBoardId === null}
              onClick={() => setPhase("confirm")}
            >
              Next →
            </button>
          </div>
        </>
      )}

      {phase === "confirm" && (
        <>
          <p>
            Exporting <strong>{selectedIds.length}</strong> shapes to{" "}
            <strong>{boards.find((b) => b.id === selectedBoardId)?.name}</strong>
          </p>
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setPhase("pick")}>← Back</button>
            <button type="button" onClick={() => void runExport()}>Export</button>
          </div>
        </>
      )}

      {phase === "exporting" && (
        <div>
          <p>Exporting… (this may take a few seconds)</p>
        </div>
      )}

      {phase === "result" && result && (
        <div>
          {result.ok ? (
            <>
              <p>
                ✓ Exported <strong>{result.itemsCreated ?? 0}</strong> items
                {result.connectorsCreated ? ` + ${result.connectorsCreated} connectors` : ""}
              </p>
              {result.boardUrl && (
                <p>
                  <a href={result.boardUrl} target="_blank" rel="noreferrer">
                    Open in Miro →
                  </a>
                </p>
              )}
              {(result.skipped?.length ?? 0) > 0 && (
                <details>
                  <summary>Skipped: {result.skipped?.length}</summary>
                  <ul>
                    {result.skipped?.map((s, i) => (
                      <li key={`${s.elementId}-${i}`}>
                        {s.elementId} — {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <>
              <p>✗ Export failed: {result.error ?? "unknown error"}</p>
              {result.hint && <pre style={{ whiteSpace: "pre-wrap" }}>{result.hint}</pre>}
            </>
          )}
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div>
          <p>✗ {errorMsg ?? "Unknown error"}</p>
          {errorHint && <pre style={{ whiteSpace: "pre-wrap" }}>{errorHint}</pre>}
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
