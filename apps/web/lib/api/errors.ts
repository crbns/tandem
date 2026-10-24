import { ConvexError, type Value } from "convex/values";
import type { Actor } from "./types";

export const API_ERROR_CODES = [
  "FORBIDDEN",
  "FILE_NOT_FOUND",
  "VERSION_CONFLICT",
  "UNAUTHENTICATED",
  "APPROVAL_REQUIRED",
  "INVALID_INPUT",
  "NETWORK",
  "NOT_IMPLEMENTED",
  "UNKNOWN",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDetails {
  /** Head version on the server; set on VERSION_CONFLICT. */
  currentVersion?: number;
  /** Head content, if the backend includes it with the conflict. */
  currentContent?: string;
  updatedBy?: Actor;
  /** Original error message, for logs only. Never shown to users verbatim. */
  cause?: string;
}

/** The only error type components ever see. Branch on `code`, never on messages. */
export class TandemApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetails;

  constructor(code: ApiErrorCode, details: ApiErrorDetails = {}) {
    super(code);
    this.name = "TandemApiError";
    this.code = code;
    this.details = details;
  }
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asActor(value: unknown): Actor | undefined {
  const v = asRecord(value);
  if (!v) return undefined;
  if ((v.actorType === "human" || v.actorType === "agent") && typeof v.actorId === "string") {
    return {
      actorType: v.actorType,
      actorId: v.actorId,
      ...(typeof v.actorName === "string" ? { actorName: v.actorName } : {}),
    };
  }
  return undefined;
}

function fromConvexError(err: ConvexError<Value>): TandemApiError {
  const data = err.data;
  if (isApiErrorCode(data)) return new TandemApiError(data);

  const record = asRecord(data);
  const code = record && isApiErrorCode(record.code) ? record.code : "UNKNOWN";
  const details: ApiErrorDetails = {};
  if (record) {
    if (typeof record.currentVersion === "number") details.currentVersion = record.currentVersion;
    if (typeof record.currentContent === "string") details.currentContent = record.currentContent;
    const updatedBy = asActor(record.updatedBy);
    if (updatedBy) details.updatedBy = updatedBy;
  }
  if (code === "UNKNOWN") details.cause = JSON.stringify(data);
  return new TandemApiError(code, details);
}

// Errors Convex raises itself (not via ConvexError) only carry a message, so
// this is the one place we match on text. Keep the patterns narrow.
const MESSAGE_PATTERNS: ReadonlyArray<[RegExp, ApiErrorCode]> = [
  [/Could not find public function/i, "NOT_IMPLEMENTED"],
  [/\b(Unauthenticated|Not authenticated|Not signed in)\b/i, "UNAUTHENTICATED"],
  [/Failed to fetch|NetworkError|Connection lost|WebSocket/i, "NETWORK"],
];

function classify(err: unknown): TandemApiError {
  if (err instanceof ConvexError) return fromConvexError(err);
  if (err instanceof Error) {
    for (const [pattern, code] of MESSAGE_PATTERNS) {
      if (pattern.test(err.message)) return new TandemApiError(code, { cause: err.message });
    }
    return new TandemApiError("UNKNOWN", { cause: err.message });
  }
  return new TandemApiError("UNKNOWN", { cause: String(err) });
}

export function normalizeError(err: unknown): TandemApiError {
  if (err instanceof TandemApiError) return err;
  const normalized = classify(err);
  // Users only see generic copy for UNKNOWN, so leave a trace for whoever is
  // debugging (e.g. a backend contract mismatch mid-demo). Logged once, here,
  // at the point of normalization; never includes file content.
  if (normalized.code === "UNKNOWN") {
    console.error("[tandem] unexpected backend error:", normalized.details.cause);
  }
  return normalized;
}
