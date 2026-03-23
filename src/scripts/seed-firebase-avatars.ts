import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import {
  getFirebaseStorageBucket,
  uploadLocalImageToAvatarBucket
} from '../utils/avatar-storage';

const SYSTEM_FILES = ['default-avatar.jpg', 'pigsail-avatar.jpg'] as const;

async function findRandomDir(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), '..', 'random'),
    path.join(process.cwd(), 'random'),
    path.resolve(__dirname, '..', '..', '..', 'random')
  ];
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, 'default-avatar.jpg'));
      return dir;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    '找不到 random 目录（需要包含 default-avatar.jpg）。请在 chat-app/server 下执行 npm run seed-storage-avatars。'
  );
}

function safeObjectSegment(filename: string): string {
  const base = path.basename(filename);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'image.jpg';
}

async function main(): Promise<void> {
  if (!getFirebaseStorageBucket()) {
    console.error('请先设置环境变量 FIREBASE_STORAGE_BUCKET，并配置 Firebase 服务账号凭据。');
    process.exit(1);
  }

  const randomDir = await findRandomDir();
  console.log('本地头像目录:', randomDir);

  const entries = await fs.readdir(randomDir);
  const imageExt = /\.(jpe?g|png|gif|webp)$/i;

  const uploadedSystem: Record<string, string> = {};

  for (const name of SYSTEM_FILES) {
    const fp = path.join(randomDir, name);
    try {
      await fs.access(fp);
    } catch {
      console.warn('跳过（文件不存在）:', name);
      continue;
    }
    const dest = `avatars/system/${name}`;
    const url = await uploadLocalImageToAvatarBucket(fp, dest);
    uploadedSystem[name] = url;
    console.log('已上传', dest);
  }

  let randomCount = 0;
  for (const file of entries) {
    if (!imageExt.test(file)) continue;
    if ((SYSTEM_FILES as readonly string[]).includes(file)) continue;
    const fp = path.join(randomDir, file);
    const st = await fs.stat(fp);
    if (!st.isFile()) continue;
    const safe = safeObjectSegment(file);
    const dest = `avatars/random/${safe}`;
    await uploadLocalImageToAvatarBucket(fp, dest);
    randomCount += 1;
    console.log('已上传', dest);
  }

  console.log('\n======== 请把下面两行加入服务端 .env（若已上传对应文件）========\n');
  if (uploadedSystem['default-avatar.jpg']) {
    console.log(`FIREBASE_STORAGE_DEFAULT_AVATAR_URL=${uploadedSystem['default-avatar.jpg']}`);
  }
  if (uploadedSystem['pigsail-avatar.jpg']) {
    console.log(`FIREBASE_STORAGE_PIGSAIL_AVATAR_URL=${uploadedSystem['pigsail-avatar.jpg']}`);
  }
  console.log('\n随机头像:', randomCount, '个 → Storage 路径前缀 avatars/random/（/api/random-avatar 会自动使用）');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
