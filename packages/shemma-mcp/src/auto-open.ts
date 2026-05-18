export type AutoOpenMode = "never" | "once" | "always" | "confirm";

export type OpenSpawnFn = (room: string) => Promise<void>;

export type AutoOpenOpts = {
  mode: AutoOpenMode;
  spawn: OpenSpawnFn;
  env: Record<string, string | undefined>;
};

export type WriteResult = {
  openedRoom?: string;
  openConsentRequired?: boolean;
};

export class AutoOpenManager {
  private openedRooms = new Set<string>();
  constructor(private opts: AutoOpenOpts) {}

  private effectiveMode(): AutoOpenMode {
    if (this.opts.env.SHEMMA_NO_BROWSER === "1") return "never";
    return this.opts.mode;
  }

  /** Called после successful write tool (НЕ для dryRun). */
  async notifyWrite(room: string): Promise<WriteResult> {
    const mode = this.effectiveMode();
    if (mode === "never") return {};
    if (mode === "confirm") return { openConsentRequired: true };
    if (mode === "once" && this.openedRooms.has(room)) return {};
    await this.opts.spawn(room);
    this.openedRooms.add(room);
    return { openedRoom: room };
  }

  /** Explicit user-invoked open; ignores mode. */
  async open(room: string): Promise<void> {
    await this.opts.spawn(room);
    this.openedRooms.add(room);
  }

  snapshot(): { mode: AutoOpenMode; openedRooms: string[] } {
    return { mode: this.effectiveMode(), openedRooms: [...this.openedRooms] };
  }
}

/** Default subprocess spawn: shells out to `shemma open <room>` detached. */
export async function defaultOpenSpawn(room: string): Promise<void> {
  const proc = Bun.spawn(["shemma", "open", room], {
    stdout: "ignore",
    stderr: "ignore",
  });
  // Don't await exit — fire and forget; daemon ensure happens inside `shemma open`.
  proc.unref?.();
}
