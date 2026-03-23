import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

function loadServiceAccount(): admin.ServiceAccount {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();

  if (json) {
    try {
      return JSON.parse(json) as admin.ServiceAccount;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }

  if (filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const raw = fs.readFileSync(resolved, 'utf8');
    return JSON.parse(raw) as admin.ServiceAccount;
  }

  throw new Error(
    'Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH in .env'
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
