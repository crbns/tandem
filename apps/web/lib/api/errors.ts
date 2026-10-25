import { ConvexError, type Value } from "convex/values";
import type { Actor } from "./types";

export const API_ERROR_CODES = [
  "LIST_LIMIT_EXCEEDED",
  "INVITE_INVALID",
  "INVITE_EXPIRED",
  "INVITE_USED",
  "INVITE_REVOKED",
  "FORBIDDEN",
  "FILE_NOT_FOUND",
  "FOLDER_NOT_FOUND",
  "NAME_EXISTS",
  "INVALID_NAME",
  "INVALID_MOVE",
  "FOLDER_TOO_DEEP",
  "FOLDER_TOO_LARGE",
  "VERSION_CONFLICT",
  "UNAUTHENTICATED",
  "APPROVAL_REQUIRED",
  "REQUEST_EXPIRED",
  "INVALID_INPUT",
  "BINARY_FILE",
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
  /** Folder revision on the server; set on a folder's VERSION_CONFLICT. */
  currentRevision?: number;
  /** NAME_EXISTS: the file or folder that already has the name. */
  existing?: { kind: "file" | "folder"; id?: string; name?: string };
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
  return (
    typeof value === "string" &&
    (API_ERROR_CODES as readonly string[]).includes(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asActor(value: unknown): Actor | undefined {
  const v = asRecord(value);
  if (!v) return undefined;
  // Canonical camelCase, or MCP's snake_case Attribution { actor_type, user_id, client }.
  const actorType = v.actorType ?? v.actor_type ?? v.type;
  const userId = v.userId ?? v.user_id;
  if (
    (actorType !== "human" && actorType !== "agent") ||
    typeof userId !== "string"
  )
    return undefined;
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  const label = str(v.label);
  const userName = str(v.userName ?? v.user_name) ?? (actorType === "human" ? label : undefined);
  const agentClient = str(v.agentClient ?? v.client);
  const agentName = str(v.agentName ?? v.agent_name) ?? (actorType === "agent" ? label : undefined);
  return {
    actorType,
    userId,
    ...(userName ? { userName } : {}),
    ...(agentClient ? { agentClient } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

function fromConvexError(err: ConvexError<Value>): TandemApiError {
  const data = err.data;
  if (isApiErrorCode(data)) return new TandemApiError(data);

  const record = asRecord(data);
  const backendCode = record && typeof record.code === "string" ? record.code : undefined;
  const code = backendCode && isApiErrorCode(backendCode)
    ? backendCode
    // A destination or parent folder that is missing or deleted (MCP maps it the same way).
    : backendCode === "INVALID_PARENT_FOLDER"
      ? "FOLDER_NOT_FOUND"
    : backendCode === "INVALID_UPLOAD_SIZE" || backendCode === "UNSUPPORTED_MIME_TYPE" || backendCode === "NOT_BINARY_FILE" || backendCode === "UPLOAD_ALREADY_FINALIZED" || backendCode === "UPLOAD_NOT_FOUND" || backendCode === "INVALID_PATH" || backendCode === "INVALID_EMAIL" || backendCode === "USER_NOT_REGISTERED"
      ? "INVALID_INPUT"
      : backendCode === "USER_NOT_INITIALIZED"
        ? "UNAUTHENTICATED"
        : backendCode === "WORKSPACE_NOT_FOUND"
          ? "FORBIDDEN"
          : backendCode === "USER_EMAIL_NOT_VERIFIED"
            ? "APPROVAL_REQUIRED"
            : "UNKNOWN";
  const details: ApiErrorDetails = {};
  if (record) {
    // Canonical keys are camelCase (CONTRACT_NOTES); snake_case is accepted so a
    // backend that reuses MCP's versionConflict() helper still reports who saved.
    const currentVersion = record.currentVersion ?? record.current_version;
    const currentContent = record.currentContent ?? record.current_content;
    if (typeof currentVersion === "number")
      details.currentVersion = currentVersion;
    if (typeof currentContent === "string")
      details.currentContent = currentContent;
    const updatedBy = asActor(record.updatedBy ?? record.updated_by);
    if (updatedBy) details.updatedBy = updatedBy;
    const currentRevision = record.currentRevision ?? record.current_revision;
    if (typeof currentRevision === "number")
      details.currentRevision = currentRevision;
    // NAME_EXISTS names what holds the name: { kind, fileId | folderId, name }.
    if (record.kind === "file" || record.kind === "folder") {
      const id = record.kind === "file" ? record.fileId ?? record.file_id : record.folderId ?? record.folder_id;
      details.existing = {
        kind: record.kind,
        ...(typeof id === "string" ? { id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      };
    }
  }
  if (code === "UNKNOWN") details.cause = JSON.stringify(data);
  return new TandemApiError(code, details);
}

// Errors Convex raises itself (not via ConvexError) only carry a message, so
// this is the one place we match on text. Keep the patterns narrow.
// Dev-only safety net: production Convex redacts non-ConvexError messages to
// "Server Error", so the backend must throw ConvexError({ code }) for every
// business error (CONTRACT_NOTES.md). Client-side NETWORK errors still match.
const MESSAGE_PATTERNS: ReadonlyArray<[RegExp, ApiErrorCode]> = [
  [/Could not find public function/i, "NOT_IMPLEMENTED"],
  [/\b(Unauthenticated|Not authenticated|Not signed in)\b/i, "UNAUTHENTICATED"],
  [/Failed to fetch|NetworkError|Connection lost|WebSocket/i, "NETWORK"],
];

function classify(err: unknown): TandemApiError {
  if (err instanceof ConvexError) return fromConvexError(err);
  if (err instanceof Error) {
    for (const [pattern, code] of MESSAGE_PATTERNS) {
      if (pattern.test(err.message))
        return new TandemApiError(code, { cause: err.message });
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
    console.error(
      "[tandem] unexpected backend error:",
      normalized.details.cause,
    );
  }
  return normalized;
}
