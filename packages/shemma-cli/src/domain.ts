import { CanvasClient } from "@shemma/client";
import { ensureSilent } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";
import { getOutput, printResponse, responseHasError } from "./ui";

function clientFor(
  profile: Profile,
  room?: string,
  space?: string,
): CanvasClient {
  return new CanvasClient({
    baseUrl: `http://localhost:${portFor(profile)}`,
    ...(room !== undefined ? { room } : {}),
    ...(space !== undefined ? { space } : {}),
  });
}

// Print response and exit(1) if the backend reported an error.
// DRW-125: error envelopes come in two shapes —
//   1. `{ ok: false, error: "..." }` from domain validation
//   2. `{ error: "..." }` from middleware short-circuits (no `ok` at all)
// Both must exit 1 symmetrically across JSON and human modes; previously only
// shape (1) triggered exit, so middleware errors (invalid_space_id,
// space_required, space_not_found) printed `✔ ok` and exited 0.
function printAndExitOnFail(res: unknown, humanLabel?: string): void {
  const ui = getOutput();
  if (ui.mode === "json") {
    process.stdout.write(JSON.stringify(res) + "\n");
  } else {
    printResponse(res, { humanSuccess: humanLabel ?? "ok" });
  }
  if (responseHasError(res)) process.exit(1);
}

async function postBatch(
  profile: Profile,
  actions: unknown[],
  extra: Record<string, unknown> = {},
  room?: string,
  space?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, room, space).applyDomain({
    actions,
    ...extra,
  });
  printAndExitOnFail(res);
}

export async function define(args: {
  role: string;
  name: string;
  label?: string;
  in?: string;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  return postBatch(
    args.profile,
    [
      {
        kind: "define",
        role: args.role,
        name: args.name,
        label: args.label,
        in: args.in,
      },
    ],
    {},
    args.room,
    args.space,
  );
}

export async function connectCmd(args: {
  from: string;
  to: string;
  kind?: string;
  label?: string;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  return postBatch(
    args.profile,
    [
      {
        kind: "connect",
        from: args.from,
        to: args.to,
        connectionKind: args.kind,
        label: args.label,
      },
    ],
    {},
    args.room,
    args.space,
  );
}

export async function group(args: {
  ids: string[];
  as: string;
  name: string;
  label?: string;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  return postBatch(
    args.profile,
    [
      {
        kind: "group",
        ids: args.ids,
        as: args.as,
        name: args.name,
        label: args.label,
      },
    ],
    {},
    args.room,
    args.space,
  );
}

export async function note(args: {
  text: string;
  about?: string;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  return postBatch(
    args.profile,
    [{ kind: "note", text: args.text, about: args.about }],
    {},
    args.room,
    args.space,
  );
}

export async function layoutCmd(args: {
  mode?: string;
  scope?: string;
  spacing?: string;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  return postBatch(
    args.profile,
    [{ kind: "layout", mode: args.mode, scope: args.scope, spacing: args.spacing }],
    {},
    args.room,
    args.space,
  );
}

export async function deleteCmd(args: {
  ids: string[];
  cascade?: boolean;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  return postBatch(
    args.profile,
    [
      args.ids.length === 1 && !args.cascade
        ? { kind: "delete", id: args.ids[0] }
        : { kind: "delete", ids: args.ids, cascade: !!args.cascade },
    ],
    {},
    args.room,
    args.space,
  );
}

export async function applyStdin(args: {
  profile: Profile;
  room?: string;
  space?: string;
}) {
  await ensureSilent(args.profile);
  const raw = await new Response(Bun.stdin.stream()).text();
  const body = JSON.parse(raw);
  const res = await clientFor(args.profile, args.room, args.space).applyDomain(
    body,
  );
  printAndExitOnFail(res);
}

export async function context(args: {
  since?: number;
  viewport?: string;
  profile: Profile;
  room?: string;
  space?: string;
}) {
  await ensureSilent(args.profile);
  const res = await clientFor(args.profile, args.room, args.space).getContext({
    since: args.since,
    viewport: args.viewport,
  });
  printAndExitOnFail(res);
}
