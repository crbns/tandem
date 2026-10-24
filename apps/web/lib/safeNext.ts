/**
 * Post-sign-in redirect target from `?next=`. Only same-origin absolute paths
 * survive; anything else becomes "/". We resolve with the URL parser rather than
 * string checks because browsers treat `\` like `/` and strip tabs/newlines,
 * so `/\evil.com` or `/\t/evil.com` would otherwise leave the site.
 */
export function safeNext(next: string | null, origin: string): string {
  if (!next || !next.startsWith("/")) return "/";
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
