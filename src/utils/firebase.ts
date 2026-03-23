import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

function readServiceAccountFile(resolved: string): admin.ServiceAccount {
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        `Firebase service account file not found: ${resolved}. ` +
          'On Koyeb and similar hosts, set secret FIREBASE_SERVICE_ACCOUNT_JSON to the full JSON contents of your service account (not a path). ' +
          'Rebuild/redeploy so the image matches your current server code.'
      );
    }
    throw e;
  }
  return JSON.parse(raw) as admin.ServiceAccount;
}

/** True when the value is probably a filepath, not JSON (common misconfiguration). */
function looksLikeJsonCredentialPath(s: string): boolean {
  if (!/\.json$/i.test(s)) return false;
  if (path.isAbsolute(s)) return true;
  if (s.startsWith('./') || s.startsWith('../')) return true;
  return /^[a-zA-Z]:[\\/]/.test(s);
}

function loadServiceAccount(): admin.ServiceAccount {
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();

  if (jsonRaw) {
    if (jsonRaw.startsWith('{')) {
      try {
        return JSON.parse(jsonRaw) as admin.ServiceAccount;
      } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
      }
    }
    if (looksLikeJsonCredentialPath(jsonRaw)) {
      const resolved = path.isAbsolute(jsonRaw)
        ? jsonRaw
        : path.resolve(process.cwd(), jsonRaw);
      return readServiceAccountFile(resolved);
    }
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON must be the full service account JSON (text starting with {). ' +
        'Do not put only the .json filename or a server path there — paste the file contents, or use FIREBASE_SERVICE_ACCOUNT_PATH for a local file path.'
    );
  }

  if (filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    return readServiceAccountFile(resolved);
  }

  throw new Error(
    'Set FIREBASE_SERVICE_ACCOUNT_JSON (recommended for Koyeb) or FIREBASE_SERVICE_ACCOUNT_PATH'
  );
}

const serviceAccount = loadServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

// Health check — mirrors the old testConnection() signature
export const testConnection = async (): Promise<boolean> => {
  try {
    await db.collection('_health').doc('ping').set({
      timestamp: FieldValue.serverTimestamp()
    });
    console.log('✅ Firestore connection successful');
    return true;
  } catch (error) {
    console.error('❌ Firestore connection failed:', error);
    return false;
  }
};

// No-op — Firestore SDK manages its own connections
export const closePool = async (): Promise<void> => {
  console.log('🔒 Firestore connection closed');
};

export default admin;
