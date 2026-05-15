import { CanvasClient } from "@didraw/client";
import { ensureSilent } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";

function clientFor(profile: Profile): CanvasClient {
  return new CanvasClient({ baseUrl: `http://localhost:${portFor(profile)}` });
}

async function postBatch(profile: Profile, actions: unknown[], extra: Record<string, unknown> = {}) {
  await ensureSilent(profile);
  const res = await clientFor(profile).applyDomain({ actions, ...extra });
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function define(args: { role: string; name: string; label?: string; in?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "define", role: args.role, name: args.name, label: args.label, in: args.in }]);
}

export async function connectCmd(args: { from: string; to: string; kind?: string; label?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "connect", from: args.from, to: args.to, connectionKind: args.kind, label: args.label }]);
}

export async function group(args: { ids: string[]; as: string; name: string; label?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "group", ids: args.ids, as: args.as, name: args.name, label: args.label }]);
}

export async function note(args: { text: string; about?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "note", text: args.text, about: args.about }]);
}

export async function layoutCmd(args: { mode?: string; scope?: string; spacing?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "layout", mode: args.mode, scope: args.scope, spacing: args.spacing }]);
}

export async function deleteCmd(args: { ids: string[]; cascade?: boolean; profile: Profile }) {
  return postBatch(
    args.profile,
    [args.ids.length === 1 && !args.cascade ? { kind: "delete", id: args.ids[0] } : { kind: "delete", ids: args.ids, cascade: !!args.cascade }],
  );
}

export async function applyStdin(args: { profile: Profile }) {
  await ensureSilent(args.profile);
  const raw = await new Response(Bun.stdin.stream()).text();
  const body = JSON.parse(raw);
  const res = await clientFor(args.profile).applyDomain(body);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function context(args: { since?: number; viewport?: string; profile: Profile }) {
  await ensureSilent(args.profile);
  const res = await clientFor(args.profile).getContext({ since: args.since, viewport: args.viewport });
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}
