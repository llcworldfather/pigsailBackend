import admin from 'firebase-admin';
import path from 'path';

// Load service account key from project root
const serviceAccountPath = path.resolve(__dirname, '../../../../pigsail-f5664-firebase-adminsdk-fbsvc-1bc30d4f13.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(serviceAccountPath);

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
