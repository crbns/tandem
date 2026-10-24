// Convex Auth's Password provider rejects bad logins with these error names
// (unknown email → InvalidAccountId, wrong password → InvalidSecret). Anything
// else (network, server) is NOT a credentials problem and must not be reported
// to the user as "wrong password".
const CREDENTIAL_ERRORS = /\b(InvalidSecret|InvalidAccountId|Invalid credentials)\b/;

// Sign-up failures. The backend throws WEAK_PASSWORD as a coded ConvexError;
// "Invalid password" is the provider's default check. "Account <email> already
// exists" is a plain Error, which production deployments redact, so callers
// must still treat unrecognized sign-up failures as "maybe it already exists".
const WEAK_PASSWORD_ERRORS = /\b(WEAK_PASSWORD|Invalid password)\b/;
const ACCOUNT_EXISTS_ERRORS = /\bAccount .+ already exists\b/;

export function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof Error && CREDENTIAL_ERRORS.test(err.message);
}

export function isWeakPasswordError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const data: unknown = (err as { data?: unknown }).data;
  if (data && typeof data === "object" && "code" in data && data.code === "WEAK_PASSWORD") return true;
  return WEAK_PASSWORD_ERRORS.test(err.message);
}

export function isAccountExistsError(err: unknown): boolean {
  return err instanceof Error && ACCOUNT_EXISTS_ERRORS.test(err.message);
}
