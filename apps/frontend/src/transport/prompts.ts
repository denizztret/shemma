import { room } from "./api";

export async function postPrompt(selection: string[], text: string) {
  const r = await fetch(`/api/prompt?room=${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection, text }),
  });
  return r.json();
}

export async function fetchPrompts(status = "all") {
  const r = await fetch(
    `/api/prompts?room=${encodeURIComponent(room)}&status=${status}`,
  );
  return r.json();
}

export async function deletePrompt(id: string) {
  const r = await fetch(
    `/api/prompt/${encodeURIComponent(id)}?room=${encodeURIComponent(room)}`,
    { method: "DELETE" },
  );
  return r.json();
}

export async function purgePrompts() {
  const r = await fetch(`/api/prompts?room=${encodeURIComponent(room)}`, {
    method: "DELETE",
  });
  return r.json();
}
