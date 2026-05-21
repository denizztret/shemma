// DRW-116 Task 15: prompt endpoints carry both `?space=<id>&room=<id>` so the
// backend per-space prompt registry can be addressed unambiguously. Callers
// (PromptInput / PromptDrawer) now receive `(space, room)` props и пробрасывают
// их сюда вместо чтения из location.search.

function qs(space: string, room: string): string {
  return `space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
}

export async function postPrompt(
  space: string,
  room: string,
  selection: string[],
  text: string,
) {
  const r = await fetch(`/api/prompt?${qs(space, room)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection, text }),
  });
  return r.json();
}

export async function fetchPrompts(
  space: string,
  room: string,
  status = "all",
) {
  const r = await fetch(`/api/prompts?${qs(space, room)}&status=${status}`);
  return r.json();
}

export async function deletePrompt(space: string, room: string, id: string) {
  const r = await fetch(
    `/api/prompt/${encodeURIComponent(id)}?${qs(space, room)}`,
    { method: "DELETE" },
  );
  return r.json();
}

export async function purgePrompts(space: string, room: string) {
  const r = await fetch(`/api/prompts?${qs(space, room)}`, {
    method: "DELETE",
  });
  return r.json();
}
