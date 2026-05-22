/**
 * OS-specific shell command that reveals a folder/file in the default
 * file manager. Used by both the CLI (`shemma s reveal`) and the backend
 * `POST /api/spaces/:id/reveal` endpoint.
 *
 * Pure (no FS access); side-effects happen at the spawn call-site.
 */
export function platformRevealCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}
