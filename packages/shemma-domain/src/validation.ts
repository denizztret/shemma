const NAME_RE = /^[a-z0-9_-]{1,64}$/;
export function isValidName(s: string): boolean {
  return NAME_RE.test(s);
}
