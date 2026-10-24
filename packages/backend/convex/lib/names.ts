// Keep in sync with apps/mcp/src/names.ts: every backend must compute the same
// key so NAME_EXISTS behaves identically for the dashboard, MCP and the mock.

/** Zero-width characters that render as nothing: U+200B-U+200D, U+2060, U+FEFF. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export const MAX_NAME_LENGTH = 255;

/** Display form stored for a file name: Unicode NFC, zero-width characters removed, trimmed. */
export function storedName(name: string): string {
  return name.normalize("NFC").replace(ZERO_WIDTH, "").trim();
}

/**
 * Whether a new file or folder name (already `storedName`) is allowed:
 * 1–255 chars, no "/", and not "." or "..". Legacy rows are not re-checked.
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
 * Collision key: NFKC, strip zero-width characters, trim, collapse internal
 * whitespace, case-fold (uppercase then lowercase, so "ß" and "SS" collide).
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
