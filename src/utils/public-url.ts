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

  const port = process.env.PORT || '5000';
  return `http://localhost:${port}`;
}

/** Join public base with a path that starts with "/". */
export function joinPublicPath(publicBase: string, pathname: string): string {
  const base = publicBase.replace(/\/$/, '');
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

/**
 * Browsers cannot load gs:// — convert to Firebase REST download URL (no token).
 * Used for `FIREBASE_STORAGE_*_AVATAR_URL` when those env vars are gs:// (supported convention).
 * Requires Storage rules to allow read, or use https+token URLs in env instead.
 */
export function gsUriToFirebaseHttpsDownloadUrl(gs: string): string | null {
  const m = /^gs:\/\/([^/]+)\/(.+)$/i.exec(String(gs).trim());
  if (!m) return null;
  const bucket = m[1];
  const objectPath = m[2].replace(/^\/+/, '');
  if (!objectPath) return null;
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encoded}?alt=media`;
}

/** e.g. client bug: "https//firebasestorage..." (missing colon). */
function fixBrokenSchemePrefix(s: string): string {
  return s.replace(/^https\/\//i, 'https://').replace(/^http\/\//i, 'http://');
}

function startsWithIgnoreCase(haystack: string, prefix: string): boolean {
  return (
    haystack.length >= prefix.length &&
    haystack.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  );
}

/**
 * Undo "SERVER_URL + firebaseUrl" with no separator, or with a mangled https prefix.
 * Example: https://api.koyeb.apphttps//firebasestorage.googleapis.com/...
 */
function stripAccidentalPublicBaseBeforeAbsoluteUrl(
  trimmed: string,
  base: string
): string | null {
  const b = base.replace(/\/$/, '');
  if (!b || !startsWithIgnoreCase(trimmed, b)) return null;
  let rest = trimmed.slice(b.length);
  if (rest.startsWith('/') && /^\/https?\/?\//i.test(rest)) {
    rest = rest.slice(1);
  }
  rest = fixBrokenSchemePrefix(rest);
  if (/^https?:\/\//i.test(rest)) return rest;
  return null;
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
  let trimmed = String(avatar).trim();
  if (!trimmed) return avatar;

  trimmed = fixBrokenSchemePrefix(trimmed);

  const fromGs = gsUriToFirebaseHttpsDownloadUrl(trimmed);
  if (fromGs) {
    return normalizeAvatarUrl(fromGs, publicBase);
  }

  const stripped = stripAccidentalPublicBaseBeforeAbsoluteUrl(trimmed, base);
  if (stripped) {
    return normalizeAvatarUrl(stripped, publicBase);
  }

  // Undo accidental "baseURL + absolute URL" concatenation from older clients
  const doubleUrl = trimmed.match(
    /^(https?:\/\/[^/]+)((?:https?:\/\/|https\/\/|http\/\/).+)$/i
  );
  if (doubleUrl) {
    return normalizeAvatarUrl(fixBrokenSchemePrefix(doubleUrl[2]), publicBase);
  }

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
    return trimmed;
  }

  return trimmed;
}
