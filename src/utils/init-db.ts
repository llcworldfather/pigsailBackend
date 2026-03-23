import { testConnection } from './firebase';

async function initializeDatabase() {
  console.log('🔧 Initializing Firestore connection...');

  const connected = await testConnection();
  if (!connected) {
    console.error('❌ Cannot connect to Firestore');
    process.exit(1);
  }

  console.log('✅ Firestore ready — collections are created automatically on first write');
  process.exit(0);
}

initializeDatabase().catch(console.error);
