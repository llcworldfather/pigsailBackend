import { dbStorage } from './db-storage';
import { getPigsailAvatarUrl } from './avatar-storage';

const PIGSAIL_USERNAME = 'pigsail';

/** True if DB value should be replaced with getPigsailAvatarUrl(publicBase). */
export function pigsailStoredAvatarShouldUpdate(
  stored: string | undefined,
  desired: string
): boolean {
  const s = (stored || '').trim();
  const d = desired.trim();
  if (!s) return true;
  if (s === d) return false;
  if (s.includes('ui-avatars.com')) return true;
  if (/localhost|127\.0\.0\.1/i.test(s)) return true;
  if (/\/random\/pigsail-avatar\.jpg/i.test(s)) return true;
  const envPig = process.env.FIREBASE_STORAGE_PIGSAIL_AVATAR_URL?.trim();
  if (envPig && s !== envPig) return true;
  if (
    d.includes('firebasestorage.googleapis.com') &&
    !s.includes('firebasestorage.googleapis.com')
  ) {
    return true;
  }
  return false;
}

/**
 * PigSail defaults to /random/pigsail-avatar.jpg, which often 404s on cloud deploys.
 * When FIREBASE_STORAGE_PIGSAIL_AVATAR_URL or startup-resolved Storage URL is used, refresh legacy /random/ or API-host URLs.
 */
export async function ensurePigsailAvatarSynced(publicBase: string): Promise<void> {
  try {
    const pigsailUser = await dbStorage.getUserByUsername(PIGSAIL_USERNAME);
    if (!pigsailUser) return;
    const desired = getPigsailAvatarUrl(publicBase);
    if (!pigsailStoredAvatarShouldUpdate(pigsailUser.avatar, desired)) return;
    await dbStorage.updateUser(pigsailUser.id, { avatar: desired });
    console.log('[pigsail] Synced system user avatar to current default URL');
  } catch (e) {
    console.error('[pigsail] ensurePigsailAvatarSynced:', e);
  }
}
