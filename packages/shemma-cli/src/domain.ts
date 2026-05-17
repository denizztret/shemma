import { CanvasClient } from "@shemma/client";
import { ensureSilent } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";

function clientFor(profile: Profile, room?: string): CanvasClient {
  return new CanvasClient({
    baseUrl: `http://localhost:${portFor(profile)}`,
    ...(room !== undefined ? { room } : {}),
  });
}

// Print response JSON and exit(1) if the backend reported ok:false.
// All domain commands share this terminal shape — keep it in one place.
function printAndExitOnFail(res: unknown): void {
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

async function postBatch(
  profile: Profile,
  actions: unknown[],
  extra: Record<string, unknown> = {},
  room?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, room).applyDomain({ actions, ...extra });
  printAndExitOnFail(res);
}

export async function define(args: { role: string; name: string; label?: string; in?: string; profile: Profile; room?: string }) {
  return postBatch(args.profile, [{ kind: "define", role: args.role, name: args.name, label: args.label, in: args.in }], {}, args.room);
}

export async function connectCmd(args: { from: string; to: string; kind?: string; label?: string; profile: Profile; room?: string }) {
  return postBatch(args.profile, [{ kind: "connect", from: args.from, to: args.to, connectionKind: args.kind, label: args.label }], {}, args.room);
}

export async function group(args: { ids: string[]; as: string; name: string; label?: string; profile: Profile; room?: string }) {
  return postBatch(args.profile, [{ kind: "group", ids: args.ids, as: args.as, name: args.name, label: args.label }], {}, args.room);
}

export async function note(args: { text: string; about?: string; profile: Profile; room?: string }) {
  return postBatch(args.profile, [{ kind: "note", text: args.text, about: args.about }], {}, args.room);
}

export async function layoutCmd(args: { mode?: string; scope?: string; spacing?: string; profile: Profile; room?: string }) {
  return postBatch(args.profile, [{ kind: "layout", mode: args.mode, scope: args.scope, spacing: args.spacing }], {}, args.room);
}

export async function deleteCmd(args: { ids: string[]; cascade?: boolean; profile: Profile; room?: string }) {
  return postBatch(
    args.profile,
    [args.ids.length === 1 && !args.cascade ? { kind: "delete", id: args.ids[0] } : { kind: "delete", ids: args.ids, cascade: !!args.cascade }],
    {},
    args.room,
  );
}

export async function applyStdin(args: { profile: Profile; room?: string }) {
  await ensureSilent(args.profile);
  const raw = await new Response(Bun.stdin.stream()).text();
  const body = JSON.parse(raw);
  const res = await clientFor(args.profile, args.room).applyDomain(body);
  printAndExitOnFail(res);
}

export async function context(args: { since?: number; viewport?: string; profile: Profile; room?: string }) {
  await ensureSilent(args.profile);
  const res = await clientFor(args.profile, args.room).getContext({ since: args.since, viewport: args.viewport });
  printAndExitOnFail(res);
}
