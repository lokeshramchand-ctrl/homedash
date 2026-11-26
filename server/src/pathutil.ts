// One definition of "what path was really requested", shared by the auth hook and the rate limiter.
// Fastify decodes percent-escapes before routing ("/%61pi/x" reaches the /api/x handler), so any guard that
// looks at the raw URL alone can be skipped. Always test the decoded path AND the route that matched.

export function decodedPath(url: string): string {
  const raw = url.split('?')[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** True when the request is (or was routed to) an /api endpoint. */
export function isApiRequest(url: string, routed?: string): boolean {
  return decodedPath(url).startsWith('/api/') || (routed ?? '').startsWith('/api/');
}
