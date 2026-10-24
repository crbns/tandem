/** Zero-width characters that render as nothing: U+200B-U+200D, U+2060, U+FEFF. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/**
 * Key used to decide whether two file names collide (NAME_EXISTS). Applied in
 * this order: Unicode NFKC, strip zero-width characters, trim, collapse internal
 * whitespace runs to one space, lowercase. Every backend and the dashboard must
 * compute it identically, so keep this the single implementation.
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
