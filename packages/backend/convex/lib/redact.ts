// Redaction for activity_events payloads (docs/context-intelligence.md). Tool
// arguments and hook bodies can carry credentials and whole documents; what we
// store is a bounded, secret-free JSON summary of them. Untrusted text either
// way: nothing here makes a payload safe to execute.

/** activity_events.payload is capped at this many characters. */
export const PAYLOAD_MAX_CHARS = 4000;

const REDACTED = "[redacted]";

const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key|session[_-]?token/i;

// Inline substitutions, so a Bash command keeps its shape around the secret.
const SECRET_VALUES: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bmcp_sk_[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // FOO_TOKEN=..., PASSWORD="..." in commands and env dumps.
  [
    /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api_?key)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi,
    `$1=${REDACTED}`,
  ],
];

// Regexes only scan this much past the kept length, which bounds the work on
// huge strings; a PEM key still fits whole.
const SCAN_MARGIN = 4096;

export interface RedactOptions {
  /** Longest kept string value (default 500). */
  maxString?: number;
  /** Keys whose string values become `{ chars, preview }` (default ["content"]). */
  previewKeys?: string[];
  /** Characters kept in a preview (default 200). */
  previewChars?: number;
  maxDepth?: number;
  maxArray?: number;
  /** Cap on the serialized JSON (default PAYLOAD_MAX_CHARS). */
  maxChars?: number;
}

function scrub(s: string): string {
  let out = s;
  for (const [pattern, replacement] of SECRET_VALUES) out = out.replace(pattern, replacement);
  return out;
}

/** Secret-like substrings replaced, then cut to `max` characters with an ellipsis. */
export function redactText(s: string, max: number): string {
  const out = scrub(s.length > max + SCAN_MARGIN ? s.slice(0, max + SCAN_MARGIN) : s);
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}

/** Like redactText, but keeps the end (output tails). */
export function redactTail(s: string, max: number): string {
  const out = scrub(s.length > max + SCAN_MARGIN ? s.slice(-(max + SCAN_MARGIN)) : s);
  return out.length > max ? `…${out.slice(-(max - 1))}` : out;
}

interface Limits {
  maxString: number;
  previewKeys: Set<string>;
  previewChars: number;
  maxDepth: number;
  maxArray: number;
}

function walk(value: unknown, limits: Limits, depth: number, key?: string): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (key !== undefined && limits.previewKeys.has(key))
      return { chars: value.length, preview: redactText(value, limits.previewChars) };
    return redactText(value, limits.maxString);
  }
  if (typeof value !== "object") return undefined;
  if (depth >= limits.maxDepth) return "[depth]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, limits.maxArray)
      .map((item) => walk(item, limits, depth + 1) ?? null);
    if (value.length > limits.maxArray) items.push(`[+${value.length - limits.maxArray} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(value)) {
    if (kept >= limits.maxArray * 2) {
      out["[truncated]"] = true;
      break;
    }
    const name = k.slice(0, 64);
    if (SECRET_KEY.test(k)) {
      out[name] = REDACTED;
    } else {
      const walked = walk(v, limits, depth + 1, k);
      if (walked === undefined) continue;
      out[name] = walked;
    }
    kept++;
  }
  return out;
}

/**
 * Redacted JSON of `value`, at most `maxChars` long: secret-named keys and
 * secret-looking strings become "[redacted]", long strings are cut, preview
 * keys keep only their length and a short prefix, and depth and array length
 * are capped. Too big even then, it tightens the limits once and finally
 * falls back to a redacted string preview. undefined for undefined.
 */
export function redactPayload(value: unknown, opts: RedactOptions = {}): string | undefined {
  if (value === undefined) return undefined;
  const maxChars = opts.maxChars ?? PAYLOAD_MAX_CHARS;
  const limits: Limits = {
    maxString: opts.maxString ?? 500,
    previewKeys: new Set(opts.previewKeys ?? ["content"]),
    previewChars: opts.previewChars ?? 200,
    maxDepth: opts.maxDepth ?? 4,
    maxArray: opts.maxArray ?? 20,
  };
  const first = JSON.stringify(walk(value, limits, 0) ?? null);
  if (first.length <= maxChars) return first;
  const tight: Limits = {
    ...limits,
    maxString: Math.min(limits.maxString, 120),
    previewChars: Math.min(limits.previewChars, 80),
    maxDepth: Math.min(limits.maxDepth, 3),
    maxArray: Math.min(limits.maxArray, 5),
  };
  const second = JSON.stringify(walk(value, tight, 0) ?? null);
  if (second.length <= maxChars) return second;
  // Escaping can grow the preview, so halve it until it fits.
  for (let keep = Math.max(0, maxChars - 100); ; keep = Math.floor(keep / 2)) {
    const fallback = JSON.stringify({ truncated: true, chars: second.length, preview: second.slice(0, keep) });
    if (fallback.length <= maxChars || keep === 0) return fallback;
  }
}
