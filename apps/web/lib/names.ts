// Mirrors packages/backend/convex/lib/names.ts (and apps/mcp/src/names.ts) so
// the mock reports NAME_EXISTS for exactly the names the backend would. Keep
// all three in sync.

/** Zero-width characters that render as nothing: U+200B-U+200D, U+2060, U+FEFF. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export const MAX_NAME_LENGTH = 255;

/** Display form stored for a name: Unicode NFC, zero-width characters removed, trimmed. */
export function storedName(name: string): string {
  return name.normalize("NFC").replace(ZERO_WIDTH, "").trim();
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
