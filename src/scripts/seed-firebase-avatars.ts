import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

// =====================================================================
// ⚠️ 仅你本机一次性使用：跑完 npm run seed-storage-avatars 后请删掉这段配置
//    （或删掉整个脚本），不要把密钥提交到 Git。
// =====================================================================
const ONE_TIME_FIREBASE_LOCAL = {
  storageBucket: 'pigsail-f5664.firebasestorage.app',

  /** 服务账号 JSON 路径（不要包一层引号；Windows 用 \\ 或 /） */
  serviceAccountPath:
    'C:\\Users\\00109151\\Desktop\\pigsail-f5664-firebase-adminsdk-fbsvc-1bc30d4f13.json',

  /**
   * 若不想放文件，可把服务账号 JSON 整段粘在这里（建议压缩成一行）。
   * 非空时优先于 serviceAccountPath。
   */
  serviceAccountJson: ''
};
// =====================================================================

const SYSTEM_FILES = ['default-avatar.jpg', 'pigsail-avatar.jpg'] as const;

/** 去掉用户误加的外层 " 或 '，避免 path 解析错 */
function normalizeCredentialPath(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return path.normalize(s);
}

function applyOneTimeFirebaseLocal(): void {
  // 先清掉 .env 里可能存在的配置，否则 firebase.ts 会优先读 FIREBASE_SERVICE_ACCOUNT_JSON=xxx.json
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  process.env.FIREBASE_STORAGE_BUCKET = ONE_TIME_FIREBASE_LOCAL.storageBucket;

  const jsonInline = ONE_TIME_FIREBASE_LOCAL.serviceAccountJson?.trim();
  if (jsonInline) {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = jsonInline;
    return;
  }

  const raw = ONE_TIME_FIREBASE_LOCAL.serviceAccountPath?.trim();
  if (!raw) {
    console.error('请在本脚本 ONE_TIME_FIREBASE_LOCAL 里填写 serviceAccountPath 或 serviceAccountJson。');
    process.exit(1);
  }

  const p = normalizeCredentialPath(raw);
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.isAbsolute(p)
    ? p
    : path.join(process.cwd(), p);
}

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
  applyOneTimeFirebaseLocal();

  // 必须在设置好 process.env 之后再加载（否则会先读空环境变量并抛错）
  const { getFirebaseStorageBucket, uploadLocalImageToAvatarBucket } = await import(
    '../utils/avatar-storage'
  );

  if (!getFirebaseStorageBucket()) {
    console.error('FIREBASE_STORAGE_BUCKET 未生效。');
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

  const bucket = ONE_TIME_FIREBASE_LOCAL.storageBucket;
  console.log('\n======== 系统头像在 Storage 中的位置（服务端也可仅靠 bucket + Admin SDK 自动解析）========');
  console.log(`gs://${bucket}/${'avatars/system/default-avatar.jpg'}`);
  console.log(`gs://${bucket}/${'avatars/system/pigsail-avatar.jpg'}`);
  console.log('\n可选 .env（覆盖自动解析的下载 URL）：\n');
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
