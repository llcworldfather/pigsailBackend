import { db, FieldValue, Timestamp } from '../utils/firebase';
import { DebateMessageMeta, Message } from '../types';
import { DocumentData } from 'firebase-admin/firestore';

const MESSAGES = 'messages';
const CHATS = 'chats';

function docToMessage(id: string, data: DocumentData): Message {
  let debate: DebateMessageMeta | undefined;
  const dm = data.debate as DocumentData | undefined;
  if (dm && dm.side && dm.round && dm.role) {
    debate = {
      side: dm.side as DebateMessageMeta['side'],
      round: dm.round as DebateMessageMeta['round'],
      role: dm.role as DebateMessageMeta['role']
    };
  }
  return {
    id,
    chatId: data.chatId,
    senderId: data.senderId,
    content: data.content,
    timestamp: data.createdAt?.toDate() || new Date(),
    type: data.type || 'text',
    readBy: (data.readBy as string[]) || [],
    isEdited: data.isEdited || false,
    editedAt: data.editedAt?.toDate?.(),
    replyToId: data.replyToId || data.replyToMessageId || undefined,
    isDeleted: data.isDeleted || false,
    deletedAt: data.deletedAt?.toDate?.(),
    deletedBy: data.deletedBy || undefined,
    reactions: (data.reactions as Record<string, string[]>) || {},
    debate
  };
}

export class MessageDAO {
  // Create a message and update the parent chat atomically
  static async create(messageData: Omit<Message, 'readBy' | 'isEdited'>): Promise<Message> {
    const now = Timestamp.now();

    const docData: Record<string, unknown> = {
      chatId: messageData.chatId,
      senderId: messageData.senderId,
      content: messageData.content,
      type: messageData.type || 'text',
      replyToId: messageData.replyToId || null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      reactions: messageData.reactions || {},
      readBy: [messageData.senderId],
      createdAt: now,
      updatedAt: now
    };
    if (messageData.debate) {
      docData.debate = {
        side: messageData.debate.side,
        round: messageData.debate.round,
        role: messageData.debate.role
      };
    }

    await db.collection(MESSAGES).doc(messageData.id).set(docData);

    // Update chat: cache last message data and increment unread counts
    const chatDoc = await db.collection(CHATS).doc(messageData.chatId).get();
    if (chatDoc.exists) {
      const chatData = chatDoc.data()!;
      const participants = (chatData.participants as string[]) || [];

      const lastMessageData = {
        id: messageData.id,
        chatId: messageData.chatId,
        senderId: messageData.senderId,
        content: messageData.content,
        timestamp: now,
        type: messageData.type || 'text',
        readBy: [messageData.senderId],
        isEdited: false,
        isDeleted: false
      };

      const chatUpdate: Record<string, unknown> = {
        lastMessageId: messageData.id,
        lastMessageData,
        updatedAt: now
      };

      // Increment unread count for every participant except the sender
      for (const participantId of participants) {
        if (participantId !== messageData.senderId) {
          chatUpdate[`participantData.${participantId}.unreadCount`] = FieldValue.increment(1);
        }
      }

      await db.collection(CHATS).doc(messageData.chatId).update(chatUpdate);
    }

    return {
      id: messageData.id,
      chatId: messageData.chatId,
      senderId: messageData.senderId,
      content: messageData.content,
      timestamp: now.toDate(),
      type: messageData.type || 'text',
      readBy: [messageData.senderId],
      isEdited: false,
      replyToId: messageData.replyToId,
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      editedAt: undefined,
      reactions: messageData.reactions || {},
      debate: messageData.debate
    };
  }

  // Get messages for a chat, ordered oldest-first, with limit/offset support.
  // Sorting is done client-side to avoid requiring a Firestore composite index
  // on (chatId, createdAt). Deploy firestore.indexes.json to enable server-side ordering.
  //
  // offset === 0: return the **most recent** `limit` messages (chat open / refresh).
  // Previously this used slice(0, limit) which returned the **oldest** 50 — so any
  // chat with >50 messages showed stale history while the sidebar still showed lastMessage.
  static async findByChatId(chatId: string, limit: number = 50, offset: number = 0): Promise<Message[]> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const sorted = snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (offset === 0) {
      return sorted.slice(-limit);
    }
    return sorted.slice(offset, offset + limit);
  }

  // Load messages older than a specific anchor message (excluding anchor), oldest-first.
  static async findByChatIdBeforeMessage(
    chatId: string,
    beforeMessageId: string,
    limit: number = 30
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const sorted = snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (sorted.length === 0) {
      return { messages: [], hasMore: false };
    }

    const anchorIndex = sorted.findIndex(m => m.id === beforeMessageId);
    const end = anchorIndex >= 0 ? anchorIndex : sorted.length;
    const start = Math.max(0, end - limit);

    return {
      messages: sorted.slice(start, end),
      hasMore: start > 0
    };
  }

  /** 获取最近 N 条消息（用于摘要），按时间正序返回 */
  static async getLastMessages(chatId: string, limit: number = 100): Promise<Message[]> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const sorted = snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .filter(m => !m.isDeleted)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return sorted.slice(-limit);
  }

  /** 以指定消息为中心加载附近的消息（用于搜索跳转） */
  static async findByChatIdAroundMessage(chatId: string, anchorMessageId: string, limit: number = 50): Promise<Message[]> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const sorted = snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .filter(m => !m.isDeleted)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const idx = sorted.findIndex(m => m.id === anchorMessageId);
    console.log('[MessageDAO] findByChatIdAroundMessage:', { chatId, anchorMessageId, totalMessages: sorted.length, idx, found: idx >= 0 });
    if (idx < 0) return sorted.slice(-limit); // 未找到则返回最近 limit 条

    const half = Math.floor(limit / 2);
    // Keep window size near `limit` even when anchor is close to edges.
    const maxStart = Math.max(0, sorted.length - limit);
    const start = Math.max(0, Math.min(idx - half, maxStart));
    const end = Math.min(sorted.length, start + limit);
    return sorted.slice(start, end);
  }

  /**
   * 加载以某条消息为「最新一条」的连续历史：返回时间正序，最后一条为 anchor（用于预览：底部对齐该条，向上可看上文）
   */
  static async findByChatIdEndingAtMessage(chatId: string, anchorMessageId: string, limit: number = 50): Promise<Message[]> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const sorted = snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .filter(m => !m.isDeleted)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const idx = sorted.findIndex(m => m.id === anchorMessageId);
    if (idx < 0) return sorted.slice(-limit).filter(m => m.type !== 'system');

    const start = Math.max(0, idx - limit + 1);
    return sorted.slice(start, idx + 1).filter(m => m.type !== 'system');
  }

  // Get a single message by ID
  static async findById(id: string): Promise<Message | null> {
    const doc = await db.collection(MESSAGES).doc(id).get();
    if (!doc.exists) return null;
    return docToMessage(doc.id, doc.data()!);
  }

  // Edit message content (only the original sender may edit)
  static async update(messageId: string, content: string, senderId: string): Promise<Message | null> {
    const msgRef = db.collection(MESSAGES).doc(messageId);
    const doc = await msgRef.get();

    if (!doc.exists || doc.data()!.senderId !== senderId) return null;

    const now = Timestamp.now();
    await msgRef.update({ content, isEdited: true, editedAt: now, updatedAt: now });

    const updated = await msgRef.get();
    return docToMessage(updated.id, updated.data()!);
  }

  // Mark a single message as read by a user
  static async markAsRead(messageId: string, userId: string): Promise<boolean> {
    try {
      await db.collection(MESSAGES).doc(messageId).update({
        readBy: FieldValue.arrayUnion(userId)
      });
      return true;
    } catch {
      return false;
    }
  }

  // Mark a list of messages as read by a user (skips messages sent by the user)
  static async markMultipleAsRead(chatId: string, userId: string, messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0;

    let count = 0;
    const batch = db.batch();

    for (const messageId of messageIds) {
      const doc = await db.collection(MESSAGES).doc(messageId).get();
      if (doc.exists && doc.data()!.senderId !== userId) {
        batch.update(doc.ref, { readBy: FieldValue.arrayUnion(userId) });
        count++;
      }
    }

    await batch.commit();
    return count;
  }

  // Get messages in a chat that have not yet been read by the given user
  static async getUnreadMessages(chatId: string, userId: string): Promise<Message[]> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    return snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .filter(msg => msg.senderId !== userId && !msg.readBy.includes(userId))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Total message count for a chat
  static async getMessageCount(chatId: string): Promise<number> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();
    return snapshot.size;
  }

  // Soft-delete a message (only the original sender may delete)
  static async delete(messageId: string, userId: string): Promise<boolean> {
    const msgRef = db.collection(MESSAGES).doc(messageId);
    const doc = await msgRef.get();

    if (!doc.exists || doc.data()!.senderId !== userId) return false;

    await msgRef.update({
      content: '[Message deleted]',
      type: 'system',
      isDeleted: true,
      deletedAt: Timestamp.now(),
      deletedBy: userId,
      updatedAt: Timestamp.now()
    });

    return true;
  }

  // Toggle a reaction for a message by emoji + user id.
  // If the user already reacted with that emoji, remove it; otherwise add it.
  static async toggleReaction(messageId: string, emoji: string, userId: string): Promise<Message | null> {
    const msgRef = db.collection(MESSAGES).doc(messageId);

    const updated = await db.runTransaction(async (txn) => {
      const doc = await txn.get(msgRef);
      if (!doc.exists) return null;

      const data = doc.data()!;
      const rawReactions = (data.reactions as Record<string, string[]>) || {};
      const reactions: Record<string, string[]> = { ...rawReactions };
      const currentUsers = new Set<string>(reactions[emoji] || []);

      if (currentUsers.has(userId)) {
        currentUsers.delete(userId);
      } else {
        currentUsers.add(userId);
      }

      if (currentUsers.size === 0) {
        delete reactions[emoji];
      } else {
        reactions[emoji] = Array.from(currentUsers);
      }

      txn.update(msgRef, {
        reactions,
        updatedAt: Timestamp.now()
      });

      return docToMessage(doc.id, {
        ...data,
        reactions
      });
    });

    return updated;
  }

  // Full-text search on message content (client-side filter — Firestore has no ILIKE)
  static async searchMessages(chatId: string, searchQuery: string, limit: number = 50): Promise<Message[]> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const q = searchQuery.toLowerCase();
    return snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .filter(msg => !msg.isDeleted && msg.type !== 'system' && msg.content.toLowerCase().includes(q))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  // Paginated message retrieval (page 1 = newest window; aligns with findByChatId offset 0)
  static async getMessagesWithPagination(
    chatId: string,
    page: number = 1,
    limit: number = 50
  ): Promise<{ messages: Message[]; total: number; hasMore: boolean }> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    const sorted = snapshot.docs
      .map(doc => docToMessage(doc.id, doc.data()))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const total = sorted.length;
    const endExclusive = total - (page - 1) * limit;
    const start = Math.max(0, endExclusive - limit);
    const messages = endExclusive <= 0 ? [] : sorted.slice(start, endExclusive);

    return {
      messages,
      total,
      hasMore: start > 0
    };
  }

  // Permanently delete all messages in a chat
  static async deleteByChatId(chatId: string): Promise<number> {
    const snapshot = await db.collection(MESSAGES)
      .where('chatId', '==', chatId)
      .get();

    if (snapshot.empty) return 0;

    const docs = snapshot.docs;
    let deletedCount = 0;
    const batchSize = 400;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const chunk = docs.slice(i, i + batchSize);
      chunk.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      deletedCount += chunk.length;
    }

    return deletedCount;
  }
}
