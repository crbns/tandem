/** Zero-width characters that render as nothing: U+200B-U+200D, U+2060, U+FEFF. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

export const MAX_NAME_LENGTH = 255;

/**
 * Display form a backend stores for a file name: Unicode NFC, strip zero-width
 * characters, trim. Unlike `nameKey` it keeps case and internal whitespace.
 */
export function storedName(name: string): string {
  return name.normalize("NFC").replace(ZERO_WIDTH, "").trim();
}

/**
 * Whether a new file or folder name (already `storedName`) is allowed:
 * 1–255 chars, no "/", and not "." or "..". Legacy rows are not re-checked.
 * Mirrors packages/backend/convex/lib/names.ts.
 */
export function isValidName(name: string): boolean {
  return (
    nameKey(name) !== "" &&
    name.length <= MAX_NAME_LENGTH &&
    !name.includes("/") &&
    name !== "." &&
    name !== ".."
  );
}

/**
 * Key used to decide whether two file names collide (NAME_EXISTS). Applied in
 * this order: Unicode NFKC, strip zero-width characters, trim, collapse internal
 * whitespace runs to one space, case-fold (uppercase then lowercase, so "ß" and
 * "SS" collide). Every backend and the dashboard must compute it identically,
 * so keep this the single implementation.
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .toLowerCase();
}
