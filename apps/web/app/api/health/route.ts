// Liveness for the container healthcheck. Deliberately independent of Convex
// (the proxy skips this path), so a backend outage doesn't restart the web container.
export const dynamic = "force-static";

export function GET() {
  return Response.json({ ok: true });
}
