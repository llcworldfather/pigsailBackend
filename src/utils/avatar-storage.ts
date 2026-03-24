import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import admin from './firebase';
import { joinPublicPath, normalizeAvatarUrl } from './public-url';

const PIGSAIL_AVATAR_PATH = '/random/pigsail-avatar.jpg';

/**
 * Fixed object paths under FIREBASE_STORAGE_BUCKET (see npm run seed-storage-avatars).
 * gs://pigsail-f5664.firebasestorage.app/avatars/system/default-avatar.jpg
 * gs://pigsail-f5664.firebasestorage.app/avatars/system/pigsail-avatar.jpg
 */
export const FIREBASE_SYSTEM_AVATAR_OBJECTS = {
  default: 'avatars/system/default-avatar.jpg',
  pigsail: 'avatars/system/pigsail-avatar.jpg'
} as const;

let cachedDefaultAvatarFromBucket: string | null = null;
let cachedPigsailAvatarFromBucket: string | null = null;

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export function getFirebaseStorageBucket(): string | undefined {
  return process.env.FIREBASE_STORAGE_BUCKET?.trim();
}

export function isAvatarStorageEnabled(): boolean {
  return !!getFirebaseStorageBucket();
}

/**
 * Resolve default / PigSail download URLs from Storage when env overrides are unset.
 * Call once after Firebase is ready (e.g. server startup).
 */
export async function warmSystemAvatarUrlsFromFirebase(): Promise<void> {
  cachedDefaultAvatarFromBucket = null;
  cachedPigsailAvatarFromBucket = null;
  if (!getFirebaseStorageBucket()) return;

  if (!process.env.FIREBASE_STORAGE_DEFAULT_AVATAR_URL?.trim()) {
    const url = await getFirebaseDownloadUrlForObject(FIREBASE_SYSTEM_AVATAR_OBJECTS.default);
    if (url) {
      cachedDefaultAvatarFromBucket = url;
      console.log(
        `[avatar-storage] Default avatar from Storage: ${FIREBASE_SYSTEM_AVATAR_OBJECTS.default}`
      );
    }
  }

  if (!process.env.FIREBASE_STORAGE_PIGSAIL_AVATAR_URL?.trim()) {
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
  const envUrl = process.env.FIREBASE_STORAGE_DEFAULT_AVATAR_URL?.trim();
  if (envUrl) return envUrl;
  if (cachedDefaultAvatarFromBucket) return cachedDefaultAvatarFromBucket;
  return joinPublicPath(publicBase, '/random/default-avatar.jpg');
}

export function getPigsailAvatarUrl(publicBase: string): string {
  const envUrl = process.env.FIREBASE_STORAGE_PIGSAIL_AVATAR_URL?.trim();
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
