import admin from '../utils/firebase';
import { UserDAO } from '../dao/UserDAO';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

function stringData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = String(v);
  }
  return out;
}

/**
 * Push a notification to Web FCM tokens for a user who has no active Socket.IO connection.
 * Removes tokens that FCM reports as invalid.
 */
export async function sendOfflineNewMessagePush(opts: {
  recipientUserId: string;
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
}): Promise<void> {
  const { recipientUserId, tokens, title, body, data } = opts;
  const unique = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
  if (unique.length === 0) return;

  console.log(`[FCM] sending to user=${recipientUserId} tokens=${unique.length} title=${title.slice(0, 40)}`);

  const messaging = admin.messaging();
  const dataPayload = stringData(data);
  const chunkSize = 500;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const batch = unique.slice(i, i + chunkSize);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: dataPayload,
        // Web Push：显式 webpush 块，避免仅顶层 notification 在部分浏览器/Edge 下不弹系统通知
        webpush: {
          notification: {
            title,
            body,
            icon: '/pigsail-icon.png'
          },
          headers: {
            Urgency: 'high'
          },
          fcmOptions: {
            link: '/'
          }
        }
      });

      const failCount = response.failureCount ?? 0;
      const okCount = response.successCount ?? 0;
      if (failCount > 0 || okCount > 0) {
        console.log(
          `[FCM] multicast user=${recipientUserId} success=${okCount} failure=${failCount} (batch ${batch.length})`
        );
      }

      for (let j = 0; j < response.responses.length; j++) {
        const r = response.responses[j];
        if (r.success) continue;
        const code = r.error?.code || '';
        const errMsg = r.error?.message || '';
        console.warn(`[FCM] token failure user=${recipientUserId} code=${code} message=${errMsg}`);
        if (INVALID_TOKEN_CODES.has(code)) {
          await UserDAO.removeFcmToken(recipientUserId, batch[j]);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[FCM] sendEachForMulticast threw for user ${recipientUserId}: ${msg}. ` +
          'Check Google Cloud: enable "Firebase Cloud Messaging API" for this project, and ensure the service account matches the same Firebase project as the Web app.'
      );
      throw e;
    }
  }
}
