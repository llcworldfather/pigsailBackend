import type { IncomingMessage } from 'http';

/**
 * Public base URL of this API (no trailing slash).
 * On Koyeb/production set SERVER_URL (e.g. https://your-app.koyeb.app).
 * Otherwise uses proxy headers on the incoming request, then localhost.
 */
export function getPublicServerBase(req?: IncomingMessage): string {
  const env = process.env.SERVER_URL?.trim();
  if (env) {
    return env.replace(/\/$/, '');
  }

  if (req) {
    const xfProtoRaw = req.headers['x-forwarded-proto'];
    const xfProto = Array.isArray(xfProtoRaw)
      ? xfProtoRaw[0]
      : xfProtoRaw?.split(',')[0]?.trim();
    const proto = xfProto || 'http';

    const xfHostRaw = req.headers['x-forwarded-host'];
    const xfHost = Array.isArray(xfHostRaw)
      ? xfHostRaw[0]
      : xfHostRaw?.split(',')[0]?.trim();
    const host = xfHost || req.headers.host;

    if (host) {
      return `${proto}://${host}`;
    }
  }

  const port = process.env.PORT || '5001';
  return `http://localhost:${port}`;
}

/** Join public base with a path that starts with "/". */
export function joinPublicPath(publicBase: string, pathname: string): string {
  const base = publicBase.replace(/\/$/, '');
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

/**
 * Stored avatars are often "/random/..." or "http://localhost:5000/random/...".
 * Browsers on the real frontend need absolute URLs on the API host.
 */
export function normalizeAvatarUrl(
  avatar: string | undefined,
  publicBase: string
): string | undefined {
  if (avatar === undefined || avatar === null || avatar === '') {
    return avatar;
  }

  const base = publicBase.replace(/\/$/, '');
  const trimmed = String(avatar).trim();
  if (!trimmed) return avatar;

  if (trimmed.startsWith('/')) {
    return `${base}${trimmed}`;
  }

  try {
    const u = new URL(trimmed);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') {
      return `${base}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    return avatar;
  }

  return avatar;
}
