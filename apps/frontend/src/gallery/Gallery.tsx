import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";
import { type RoomListItem, listRooms, purgeArchive } from "../transport/api";
import { fetchSession } from "../transport/session";
import { pushError } from "../state/error-bus";
import { ErrorBanner } from "../chrome/ErrorBanner";
import { type FilterTab, FilterTabs } from "./FilterTabs";
import { GroupHeader, type SortMode } from "./GroupHeader";
import { NewRoomForm } from "./NewRoomForm";
import { RoomCard } from "./RoomCard";

type RoomGroup = {
  title: string;
  rooms: RoomListItem[];
  sortMode: SortMode;
};

function prettyPath(absolute: string, home: string): string {
  if (home && absolute.startsWith(home)) {
    return `~${absolute.slice(home.length)}`;
  }
  return absolute;
}

function sortRooms(rooms: RoomListItem[], mode: SortMode): RoomListItem[] {
  return [...rooms].sort((a, b) => {
    if (mode === "name") {
      return a.id.localeCompare(b.id);
    }
    // lastTouched DESC
    return (
      Date.parse(b.lastTouched) - Date.parse(a.lastTouched)
    );
  });
}

export function Gallery() {
  const [filterTab, setFilterTab] = useState<FilterTab>("current");
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [workspaceDir, setWorkspaceDir] = useState<string>("");
  const [home, setHome] = useState<string>("");
  // Per-group sort state; keyed by group title
  const [sortModes, setSortModes] = useState<Record<string, SortMode>>({});

  useEffect(() => {
    fetchSession()
      .then((s) => {
        setSessionId(s.sessionId);
        setWorkspaceDir(s.workspaceDir ?? "");
        setHome(s.home ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    listRooms({ includeArchived: filterTab === "archived" })
      .then((res) => setRooms(res.rooms))
      .catch((e) => pushError(`Failed to load rooms: ${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, [filterTab]);

  function handleArchived(id: string) {
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }

  function handleRestored(id: string) {
    // If we're in archived tab, remove from list on restore (it goes to active)
    // If we're in current tab, add it back
    if (filterTab === "archived") {
      setRooms((prev) => prev.filter((r) => r.id !== id));
    } else {
      // Re-fetch to get restored room in active list
      listRooms({ includeArchived: false })
        .then((res) => setRooms(res.rooms))
        .catch(() => {});
    }
  }

  function handleDeleted(id: string) {
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }

  function handleRefresh() {
    listRooms({ includeArchived: filterTab === "archived" })
      .then((res) => setRooms(res.rooms))
      .catch((e) => pushError(`Failed to reload rooms: ${(e as Error).message}`));
  }

  function toggleSort(groupTitle: string) {
    setSortModes((prev) => ({
      ...prev,
      [groupTitle]: prev[groupTitle] === "name" ? "lastTouched" : "name",
    }));
  }

  async function handlePurgeArchive() {
    if (
      !window.confirm(
        "Empty the archive? All archived rooms will be permanently deleted.",
      )
    )
      return;
    try {
      const result = await purgeArchive();
      setRooms([]);
      pushError(`Removed ${result.removed} archived room(s).`);
    } catch (e) {
      pushError(`Failed to empty archive: ${(e as Error).message}`);
    }
  }

  // ─── Grouping logic ──────────────────────────────────────────────────────────
  // Current tab: group by "Current workspace" vs "Past sessions"
  // Archived tab: single group "Archived"
  const groups: RoomGroup[] = [];

  if (filterTab === "archived") {
    const groupTitle = "Archived";
    const archivedRooms = rooms.filter((r) => r.archived === true);
    groups.push({
      title: groupTitle,
      rooms: sortRooms(archivedRooms, sortModes[groupTitle] ?? "lastTouched"),
      sortMode: sortModes[groupTitle] ?? "lastTouched",
    });
  } else {
    // Current tab — split into current session vs past sessions
    const currentRooms: RoomListItem[] = [];
    const pastRooms: RoomListItem[] = [];

    for (const r of rooms) {
      if (r.archived) continue;
      // "Past sessions": rooms where linkedSession is set but NOT the current session
      const isPast =
        r.linkedSession !== undefined &&
        (sessionId === null || r.linkedSession !== sessionId);
      if (isPast) {
        pastRooms.push(r);
      } else {
        currentRooms.push(r);
      }
    }

    if (currentRooms.length > 0 || rooms.length === 0) {
      const groupTitle = "Current workspace";
      groups.push({
        title: groupTitle,
        rooms: sortRooms(currentRooms, sortModes[groupTitle] ?? "lastTouched"),
        sortMode: sortModes[groupTitle] ?? "lastTouched",
      });
    }

    if (pastRooms.length > 0) {
      const groupTitle = "Past sessions";
      groups.push({
        title: groupTitle,
        rooms: sortRooms(pastRooms, sortModes[groupTitle] ?? "lastTouched"),
        sortMode: sortModes[groupTitle] ?? "lastTouched",
      });
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f6f7f9",
        fontFamily: tokens.font.sans,
      }}
    >
      {/* Fixed error banner */}
      <ErrorBanner />

      {/* Header bar */}
      <div
        style={{
          background: tokens.color.bgOverlay,
          borderBottom: `1px solid ${tokens.color.border}`,
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 56,
          position: "sticky",
          top: 0,
          zIndex: tokens.z.overlay,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: tokens.font.base,
              fontWeight: 700,
              color: tokens.color.text,
            }}
          >
            di.draw
          </span>
          {workspaceDir && (
            <span
              style={{
                fontFamily: tokens.font.mono,
                fontSize: tokens.font.sm,
                color: tokens.color.textMuted,
                background: "rgba(0,0,0,0.05)",
                borderRadius: tokens.radius.sm,
                padding: "2px 8px",
                wordBreak: "break-all",
              }}
              title={workspaceDir}
            >
              {prettyPath(workspaceDir, home)}
            </span>
          )}
        </div>
        <NewRoomForm />
      </div>

      {/* Main content */}
      <div
        style={{
          maxWidth: 960,
          margin: "0 auto",
          padding: "24px 24px",
        }}
      >
        <h1
          style={{
            fontFamily: tokens.font.sans,
            fontSize: 22,
            fontWeight: 700,
            color: tokens.color.text,
            marginBottom: 20,
            marginTop: 0,
          }}
        >
          Rooms
        </h1>

        <FilterTabs active={filterTab} onChange={setFilterTab} />

        {/* Archived tab: "Empty archive" button */}
        {filterTab === "archived" && rooms.length > 0 && (
          <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handlePurgeArchive}
              style={{
                fontFamily: tokens.font.sans,
                fontSize: tokens.font.sm,
                color: tokens.color.errorBg,
                background: "transparent",
                border: `1px solid ${tokens.color.errorBg}`,
                borderRadius: tokens.radius.sm,
                padding: "4px 12px",
                cursor: "pointer",
              }}
            >
              Empty archive
            </button>
          </div>
        )}

        {loading ? (
          <div
            style={{
              color: tokens.color.textMuted,
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.base,
              padding: "40px 0",
              textAlign: "center",
            }}
          >
            Loading rooms…
          </div>
        ) : groups.length === 0 || groups.every((g) => g.rooms.length === 0) ? (
          <div
            style={{
              color: tokens.color.textMuted,
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.base,
              padding: "40px 0",
              textAlign: "center",
            }}
          >
            {filterTab === "archived"
              ? "No archived rooms."
              : "No rooms yet — create one above."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            {groups.map((group) =>
              group.rooms.length === 0 ? null : (
                <section key={group.title}>
                  <GroupHeader
                    title={group.title}
                    count={group.rooms.length}
                    sortMode={group.sortMode}
                    onToggleSort={() => toggleSort(group.title)}
                  />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    {group.rooms.map((r) => (
                      <RoomCard
                        key={r.id}
                        room={r}
                        sessionId={sessionId}
                        onArchived={handleArchived}
                        onRestored={handleRestored}
                        onDeleted={handleDeleted}
                        onRefresh={handleRefresh}
                      />
                    ))}
                  </div>
                </section>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
