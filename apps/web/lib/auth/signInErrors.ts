// Convex Auth's Password provider rejects bad logins with these error names
// (unknown email → InvalidAccountId, wrong password → InvalidSecret). Anything
// else (network, server) is NOT a credentials problem and must not be reported
// to the user as "wrong password".
const CREDENTIAL_ERRORS = /\b(InvalidSecret|InvalidAccountId|Invalid credentials)\b/;

export function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof Error && CREDENTIAL_ERRORS.test(err.message);
}
