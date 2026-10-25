/** Letters an invite code can use. No I or O, so codes read aloud without 1/0 mix-ups. */
export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const INVITE_CODE_LENGTH = 6;

/**
 * What a person typed or pasted, as the backend matches it: uppercase letters
 * only. Spaces, dashes and anything else are dropped, so "abc-def" and
 * "ABC DEF" both become "ABCDEF".
 */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, "");
}

/** True once a normalized code has all six letters. */
export function isCompleteInviteCode(code: string): boolean {
  return code.length === INVITE_CODE_LENGTH;
}

/** "ABCDEF" shown as "ABC DEF". Display only; copy and links use the plain code. */
export function formatInviteCode(code: string): string {
  return code.length === INVITE_CODE_LENGTH ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** A fresh code from INVITE_CODE_ALPHABET. 24 divides 240, so rejection keeps it uniform. */
export function generateInviteCode(): string {
  let code = "";
  while (code.length < INVITE_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH))) {
      if (byte < 240 && code.length < INVITE_CODE_LENGTH) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
    }
  }
  return code;
}
