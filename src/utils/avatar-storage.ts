import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import admin from './firebase';
import { gsUriToFirebaseHttpsDownloadUrl, joinPublicPath, normalizeAvatarUrl } from './public-url';

const PIGSAIL_AVATAR_PATH = '/random/pigsail-avatar.jpg';

/**
 * System avatars in Storage (see npm run seed-storage-avatars). Object paths are stable.
 *
 * **Env contract (production):** `FIREBASE_STORAGE_DEFAULT_AVATAR_URL` and
 * `FIREBASE_STORAGE_PIGSAIL_AVATAR_URL` may be set to permanent **gs://** URIs, e.g.
 *   gs://<bucket>/avatars/system/default-avatar.jpg
 *   gs://<bucket>/avatars/system/pigsail-avatar.jpg
 * The server never exposes gs:// to clients: `coerceFirebaseEnvDownloadUrl()` turns them into
 * `https://firebasestorage.googleapis.com/v0/b/.../o/...?alt=media` (requires Storage rules to
 * allow read, or use HTTPS+token URLs in env instead).
 */
export const FIREBASE_SYSTEM_AVATAR_OBJECTS = {
  default: 'avatars/system/default-avatar.jpg',
  pigsail: 'avatars/system/pigsail-avatar.jpg'
} as const;

/** gs:// URI for the default system avatar when bucket is known (for ops / logging). */
export function gsUriDefaultSystemAvatar(bucket: string): string {
  return `gs://${bucket.replace(/^\/+|\/+$/g, '')}/${FIREBASE_SYSTEM_AVATAR_OBJECTS.default}`;
}

/** gs:// URI for the PigSail system avatar when bucket is known (for ops / logging). */
export function gsUriPigsailSystemAvatar(bucket: string): string {
  return `gs://${bucket.replace(/^\/+|\/+$/g, '')}/${FIREBASE_SYSTEM_AVATAR_OBJECTS.pigsail}`;
}

let cachedDefaultAvatarFromBucket: string | null = null;
let cachedPigsailAvatarFromBucket: string | null = null;

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Reads `FIREBASE_STORAGE_DEFAULT_AVATAR_URL` / `FIREBASE_STORAGE_PIGSAIL_AVATAR_URL`.
 * Supports stable **gs://bucket/object** (recommended) or full **https://** download URLs.
 */
export function coerceFirebaseEnvDownloadUrl(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (t.startsWith('gs://')) {
    return gsUriToFirebaseHttpsDownloadUrl(t) ?? undefined;
  }
  return t;
}

export function getFirebaseStorageBucket(): string | undefined {
  return process.env.FIREBASE_STORAGE_BUCKET?.trim();
}

export function isAvatarStorageEnabled(): boolean {
  return !!getFirebaseStorageBucket();
}

/**
 * Resolve default / PigSail URLs via Admin (token) only when the corresponding env var is unset.
 * If env is set to gs:// or https://, coerce handles clients; warm is skipped for that slot.
 */
export async function warmSystemAvatarUrlsFromFirebase(): Promise<void> {
  cachedDefaultAvatarFromBucket = null;
  cachedPigsailAvatarFromBucket = null;
  if (!getFirebaseStorageBucket()) return;

  if (!coerceFirebaseEnvDownloadUrl(process.env.FIREBASE_STORAGE_DEFAULT_AVATAR_URL)) {
    const url = await getFirebaseDownloadUrlForObject(FIREBASE_SYSTEM_AVATAR_OBJECTS.default);
    if (url) {
      cachedDefaultAvatarFromBucket = url;
      console.log(
        `[avatar-storage] Default avatar from Storage: ${FIREBASE_SYSTEM_AVATAR_OBJECTS.default}`
      );
    }
  }

  if (!coerceFirebaseEnvDownloadUrl(process.env.FIREBASE_STORAGE_PIGSAIL_AVATAR_URL)) {
    const url = await getFirebaseDownloadUrlForObject(FIREBASE_SYSTEM_AVATAR_OBJECTS.pigsail);
    if (url) {
      cachedPigsailAvatarFromBucket = url;
      console.log(
        `[avatar-storage] PigSail avatar from Storage: ${FIREBASE_SYSTEM_AVATAR_OBJECTS.pigsail}`
      );
    }
  }
}

export function getDefaultAvatarUrl(publicBase: string): string {
  const envUrl = coerceFirebaseEnvDownloadUrl(process.env.FIREBASE_STORAGE_DEFAULT_AVATAR_URL);
  if (envUrl) return envUrl;
  if (cachedDefaultAvatarFromBucket) return cachedDefaultAvatarFromBucket;
  return joinPublicPath(publicBase, '/random/default-avatar.jpg');
}

export function getPigsailAvatarUrl(publicBase: string): string {
  const envUrl = coerceFirebaseEnvDownloadUrl(process.env.FIREBASE_STORAGE_PIGSAIL_AVATAR_URL);
  if (envUrl) return envUrl;
  if (cachedPigsailAvatarFromBucket) return cachedPigsailAvatarFromBucket;
  return joinPublicPath(publicBase, PIGSAIL_AVATAR_PATH);
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; mime: string } | null {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) {
    return null;
  }
  try {
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length > MAX_AVATAR_BYTES) return null;
    if (buffer.length === 0) return null;
    return { buffer, mime };
  } catch {
    return null;
  }
}

function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

/** Upload a local image file to the configured bucket; returns Firebase download URL (with token). */
export async function uploadLocalImageToAvatarBucket(
  absolutePath: string,
  objectPath: string
): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = EXT_TO_MIME[ext];
  if (!contentType) {
    throw new Error(`Unsupported image extension: ${ext || '(none)'}`);
  }
  return uploadBufferToBucket(buffer, contentType, objectPath);
}

/** Public download URL for an object uploaded with firebaseStorageDownloadTokens metadata. */
export async function getFirebaseDownloadUrlForObject(objectPath: string): Promise<string | null> {
  const bucketName = getFirebaseStorageBucket();
  if (!bucketName) return null;
  const file = admin.storage().bucket(bucketName).file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [meta] = await file.getMetadata();
  const userMeta = meta.metadata as Record<string, string> | undefined;
  const token = userMeta?.firebaseStorageDownloadTokens;
  if (!token) return null;
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

/** Pick a random image under avatars/random/ (used after seed script). */
export async function pickRandomAvatarUrlFromFirebase(): Promise<{
  url: string;
  filename: string;
} | null> {
  const bucketName = getFirebaseStorageBucket();
  if (!bucketName) return null;
  const bucket = admin.storage().bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: 'avatars/random/' });
  const paths = files
    .map((f) => f.name)
    .filter((n) => /\.(jpe?g|png|gif|webp)$/i.test(n));
  if (paths.length === 0) return null;
  const objectPath = paths[Math.floor(Math.random() * paths.length)];
  const url = await getFirebaseDownloadUrlForObject(objectPath);
  if (!url) return null;
  const filename = objectPath.replace(/^avatars\/random\//, '') || objectPath;
  return { url, filename };
}

async function uploadBufferToBucket(
  buffer: Buffer,
  contentType: string,
  objectPath: string
): Promise<string> {
  const bucketName = getFirebaseStorageBucket();
  if (!bucketName) {
    throw new Error('FIREBASE_STORAGE_BUCKET is not configured');
  }

  const bucket = admin.storage().bucket(bucketName);
  const file = bucket.file(objectPath);
  const token = randomUUID();

  await file.save(buffer, {
    metadata: {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: token
      },
      cacheControl: 'public, max-age=31536000'
    }
  });

  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

/**
 * If value is a data:image base64 URL and Storage is configured, upload and return download URL.
 * Otherwise normalize relative / localhost avatar URLs against publicBase.
 */
export async function resolveAvatarInput(
  avatar: string,
  ctx: { userId: string; kind: 'user' | 'group'; groupId?: string },
  publicBase: string
): Promise<string> {
  const trimmed = String(avatar).trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('gs://')) {
    const m = /^gs:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
    const configured = getFirebaseStorageBucket();
    if (m && configured && m[1] === configured) {
      const objectPath = m[2].replace(/^\/+/, '');
      const withToken = await getFirebaseDownloadUrlForObject(objectPath);
      if (withToken) return withToken;
    }
    const https = gsUriToFirebaseHttpsDownloadUrl(trimmed);
    if (https) return normalizeAvatarUrl(https, publicBase) ?? https;
    return trimmed;
  }

  if (trimmed.startsWith('data:image/')) {
    const parsed = parseDataUrl(trimmed);
    if (!parsed) {
      throw new Error('Invalid or oversized image (max 2MB, jpeg/png/webp/gif)');
    }
    if (!isAvatarStorageEnabled()) {
      console.warn(
        '[avatar-storage] data URL received but FIREBASE_STORAGE_BUCKET is unset; storing raw data URL in DB'
      );
      return trimmed;
    }
    const ext = extForMime(parsed.mime);
    const id = randomUUID();
    const objectPath =
      ctx.kind === 'group' && ctx.groupId
        ? `avatars/groups/${ctx.groupId}/${id}.${ext}`
        : `avatars/users/${ctx.userId}/${id}.${ext}`;
    return uploadBufferToBucket(parsed.buffer, parsed.mime, objectPath);
  }

  return normalizeAvatarUrl(trimmed, publicBase) ?? trimmed;
}

/** Used before user id exists: path is keyed by username (must be unique). */
export async function resolveAvatarInputForRegister(
  avatar: string,
  username: string,
  publicBase: string
): Promise<string> {
  const trimmed = String(avatar).trim();
  if (trimmed.startsWith('gs://')) {
    const m = /^gs:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
    const configured = getFirebaseStorageBucket();
    if (m && configured && m[1] === configured) {
      const objectPath = m[2].replace(/^\/+/, '');
      const withToken = await getFirebaseDownloadUrlForObject(objectPath);
      if (withToken) return withToken;
    }
    const https = gsUriToFirebaseHttpsDownloadUrl(trimmed);
    if (https) return normalizeAvatarUrl(https, publicBase) ?? https;
    return trimmed;
  }
  if (trimmed.startsWith('data:image/')) {
    const parsed = parseDataUrl(trimmed);
    if (!parsed) {
      throw new Error('Invalid or oversized image (max 2MB, jpeg/png/webp/gif)');
    }
    if (!isAvatarStorageEnabled()) {
      console.warn(
        '[avatar-storage] data URL on register but FIREBASE_STORAGE_BUCKET is unset; storing raw data URL'
      );
      return trimmed;
    }
    const safeUser = username.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'user';
    const ext = extForMime(parsed.mime);
    const objectPath = `avatars/users/_register_${safeUser}/${randomUUID()}.${ext}`;
    return uploadBufferToBucket(parsed.buffer, parsed.mime, objectPath);
  }
  return normalizeAvatarUrl(trimmed, publicBase) ?? trimmed;
}
