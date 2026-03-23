/**
 * One-time script: update the pigsail user's avatar in Firestore.
 * Run with:  npx ts-node src/utils/patch-pigsail-avatar.ts
 */
import 'dotenv/config';
import { db, Timestamp } from './firebase';

const PIGSAIL_AVATAR_URL = `${process.env.SERVER_URL || 'http://localhost:5000'}/random/pigsail-avatar.jpg`;

async function patchPigsailAvatar() {
  console.log('🔧 Patching pigsail avatar...');
  console.log('   Avatar URL:', PIGSAIL_AVATAR_URL);

  const snapshot = await db.collection('users')
    .where('username', '==', 'pigsail')
    .limit(1)
    .get();

  if (snapshot.empty) {
    console.log('ℹ️  Pigsail user not found in Firestore — will be created on next login.');
    process.exit(0);
  }

  const doc = snapshot.docs[0];
  await doc.ref.update({
    avatar: PIGSAIL_AVATAR_URL,
    updatedAt: Timestamp.now()
  });

  console.log(`✅ Updated pigsail (id: ${doc.id}) avatar successfully.`);
  process.exit(0);
}

patchPigsailAvatar().catch(err => {
  console.error('❌ Patch failed:', err);
  process.exit(1);
});
