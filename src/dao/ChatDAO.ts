import { db, FieldValue, Timestamp } from '../utils/firebase';
import { Chat, DebateConfig, DebateState } from '../types';
import { DocumentData } from 'firebase-admin/firestore';

const CHATS = 'chats';
const MESSAGES = 'messages';

function docToChat(id: string, data: DocumentData): Chat {
  const unreadCounts = new Map<string, number>();
  if (data.participantData) {
    for (const [userId, pData] of Object.entries(data.participantData as Record<string, DocumentData>)) {
      unreadCounts.set(userId, (pData as DocumentData).unreadCount || 0);
    }
  }

  let lastMessage = undefined;
  if (data.lastMessageData) {
    const lm = data.lastMessageData as DocumentData;
    lastMessage = {
      id: lm.id as string,
      chatId: lm.chatId as string,
      senderId: lm.senderId as string,
      content: lm.content as string,
      timestamp: lm.timestamp?.toDate?.() || new Date(),
      type: lm.type as 'text' | 'image' | 'file' | 'system',
      readBy: (lm.readBy as string[]) || [],
      isEdited: (lm.isEdited as boolean) || false,
        isDeleted: (lm.isDeleted as boolean) || false,
        replyToId: (lm.replyToId as string) || undefined,
        reactions: (lm.reactions as Record<string, string[]>) || {}
    };
  }

  let debateConfig: DebateConfig | undefined;
  const dc = data.debateConfig as DocumentData | undefined;
  if (dc && typeof dc.topic === 'string' && Array.isArray(dc.affirmativePersonas) && Array.isArray(dc.negativePersonas)) {
    debateConfig = {
      topic: dc.topic,
      affirmativePersonas: dc.affirmativePersonas as [string, string, string],
      negativePersonas: dc.negativePersonas as [string, string, string]
    };
  }

  let debateState: DebateState | undefined;
  const ds = data.debateState as DocumentData | undefined;
  if (ds && typeof ds.phase === 'string') {
    debateState = {
      phase: ds.phase as DebateState['phase'],
      currentTurnIndex: typeof ds.currentTurnIndex === 'number' ? ds.currentTurnIndex : 0,
      votes: (ds.votes as Record<string, 'affirmative' | 'negative'>) || {},
      voteCounts: ds.voteCounts as DebateState['voteCounts'],
      winner: ds.winner as DebateState['winner']
    };
  }

  return {
    id,
    type: data.type as 'private' | 'group',
    name: data.name || undefined,
    avatar: data.avatar || undefined,
    participants: (data.participants as string[]) || [],
    adminId: data.adminId || undefined,
    createdAt: data.createdAt?.toDate() || new Date(),
    lastMessage,
    unreadCounts,
    debateConfig,
    debateState
  };
}

export class ChatDAO {
  // Create a new chat with its participants
  static async create(chatData: Omit<Chat, 'createdAt' | 'unreadCounts' | 'lastMessage'> & { id: string }): Promise<Chat> {
    const now = Timestamp.now();

    const participantData: Record<string, unknown> = {};
    for (const participantId of chatData.participants) {
      participantData[participantId] = {
        joinedAt: now,
        unreadCount: 0,
        lastReadMessageId: null
      };
    }

    const docData: Record<string, unknown> = {
      type: chatData.type,
      name: chatData.name || null,
      avatar: chatData.avatar || null,
      adminId: chatData.adminId || null,
      participants: chatData.participants,
      participantData,
      lastMessageId: null,
      lastMessageData: null,
      createdAt: now,
      updatedAt: now
    };

    if (chatData.debateConfig) {
      docData.debateConfig = {
        topic: chatData.debateConfig.topic,
        affirmativePersonas: chatData.debateConfig.affirmativePersonas,
        negativePersonas: chatData.debateConfig.negativePersonas
      };
    }
    if (chatData.debateState) {
      docData.debateState = {
        phase: chatData.debateState.phase,
        currentTurnIndex: chatData.debateState.currentTurnIndex,
        votes: chatData.debateState.votes || {},
        voteCounts: chatData.debateState.voteCounts || null,
        winner: chatData.debateState.winner || null
      };
    }

    await db.collection(CHATS).doc(chatData.id).set(docData);

    return {
      id: chatData.id,
      type: chatData.type,
      name: chatData.name,
      avatar: chatData.avatar,
      participants: chatData.participants,
      adminId: chatData.adminId,
      createdAt: now.toDate(),
      lastMessage: undefined,
      unreadCounts: new Map(),
      debateConfig: chatData.debateConfig,
      debateState: chatData.debateState
    };
  }

  // Get chat by ID
  static async findById(id: string): Promise<Chat | null> {
    const doc = await db.collection(CHATS).doc(id).get();
    if (!doc.exists) return null;
    return docToChat(doc.id, doc.data()!);
  }

  // Get all chats a user participates in.
  // Sorted client-side to avoid requiring a composite index on (participants, updatedAt).
  static async findByUserId(userId: string): Promise<Chat[]> {
    const snapshot = await db.collection(CHATS)
      .where('participants', 'array-contains', userId)
      .get();
    return snapshot.docs
      .map(doc => docToChat(doc.id, doc.data()))
      .sort((a, b) => {
        const aTime = (a.lastMessage?.timestamp ?? a.createdAt).getTime();
        const bTime = (b.lastMessage?.timestamp ?? b.createdAt).getTime();
        return bTime - aTime;
      });
  }

  // Find existing private chat between two users
  static async findPrivateChat(user1Id: string, user2Id: string): Promise<Chat | null> {
    const snapshot = await db.collection(CHATS)
      .where('type', '==', 'private')
      .where('participants', 'array-contains', user1Id)
      .get();

    const match = snapshot.docs.find(doc =>
      (doc.data().participants as string[]).includes(user2Id)
    );

    if (!match) return null;
    return docToChat(match.id, match.data());
  }

  // Update the chat's last message reference and cache its data inline
  static async updateLastMessage(chatId: string, messageId: string): Promise<boolean> {
    try {
      const msgDoc = await db.collection(MESSAGES).doc(messageId).get();
      let lastMessageData = null;

      if (msgDoc.exists) {
        const d = msgDoc.data()!;
        lastMessageData = {
          id: msgDoc.id,
          chatId: d.chatId,
          senderId: d.senderId,
          content: d.content,
          timestamp: d.createdAt,
          type: d.type,
          readBy: d.readBy || [],
          isEdited: d.isEdited || false,
          isDeleted: d.isDeleted || false,
          replyToId: d.replyToId || null,
          reactions: d.reactions || {}
        };
      }

      await db.collection(CHATS).doc(chatId).update({
        lastMessageId: messageId,
        lastMessageData,
        updatedAt: Timestamp.now()
      });
      return true;
    } catch {
      return false;
    }
  }

  // Add a participant to an existing chat
  static async addParticipant(chatId: string, userId: string): Promise<boolean> {
    try {
      const now = Timestamp.now();
      await db.collection(CHATS).doc(chatId).update({
        participants: FieldValue.arrayUnion(userId),
        [`participantData.${userId}`]: {
          joinedAt: now,
          unreadCount: 0,
          lastReadMessageId: null
        },
        updatedAt: now
      });
      return true;
    } catch {
      return false;
    }
  }

  // Remove a participant; delete the chat if it becomes empty
  static async removeParticipant(chatId: string, userId: string): Promise<boolean> {
    const chatRef = db.collection(CHATS).doc(chatId);

    return await db.runTransaction(async (txn) => {
      const chatDoc = await txn.get(chatRef);
      if (!chatDoc.exists) return false;

      const participants = (chatDoc.data()!.participants as string[]).filter(id => id !== userId);

      if (participants.length === 0) {
        txn.delete(chatRef);
      } else {
        const update: Record<string, unknown> = {
          participants: FieldValue.arrayRemove(userId),
          updatedAt: Timestamp.now()
        };
        update[`participantData.${userId}`] = FieldValue.delete();
        txn.update(chatRef, update);
      }
      return true;
    });
  }

  // Reset unread count for a user and mark all chat messages as read
  static async markMessagesAsRead(chatId: string, userId: string, lastReadMessageId?: string): Promise<boolean> {
    try {
      const update: Record<string, unknown> = {
        [`participantData.${userId}.unreadCount`]: 0,
        updatedAt: Timestamp.now()
      };
      if (lastReadMessageId) {
        update[`participantData.${userId}.lastReadMessageId`] = lastReadMessageId;
      }
      await db.collection(CHATS).doc(chatId).update(update);

      // Bulk-add userId to readBy on every message not yet read by this user
      const msgsSnapshot = await db.collection(MESSAGES)
        .where('chatId', '==', chatId)
        .get();

      const batch = db.batch();
      for (const msgDoc of msgsSnapshot.docs) {
        const data = msgDoc.data();
        if (data.senderId !== userId && !(data.readBy as string[]).includes(userId)) {
          batch.update(msgDoc.ref, { readBy: FieldValue.arrayUnion(userId) });
        }
      }
      await batch.commit();

      return true;
    } catch {
      return false;
    }
  }

  // Increment or decrement unread count for a participant
  static async updateUnreadCount(chatId: string, userId: string, increment: boolean = true): Promise<boolean> {
    try {
      await db.collection(CHATS).doc(chatId).update({
        [`participantData.${userId}.unreadCount`]: increment
          ? FieldValue.increment(1)
          : FieldValue.increment(-1)
      });
      return true;
    } catch {
      return false;
    }
  }

  static async updateDebateState(chatId: string, debateState: DebateState, debateConfig?: DebateConfig): Promise<boolean> {
    try {
      const update: Record<string, unknown> = {
        debateState: {
          phase: debateState.phase,
          currentTurnIndex: debateState.currentTurnIndex,
          votes: debateState.votes || {},
          voteCounts: debateState.voteCounts ?? null,
          winner: debateState.winner ?? null
        },
        updatedAt: Timestamp.now()
      };
      if (debateConfig) {
        update.debateConfig = {
          topic: debateConfig.topic,
          affirmativePersonas: debateConfig.affirmativePersonas,
          negativePersonas: debateConfig.negativePersonas
        };
      }
      await db.collection(CHATS).doc(chatId).update(update);
      return true;
    } catch {
      return false;
    }
  }

  // Update group chat profile fields (name/avatar)
  static async updateGroupProfile(
    chatId: string,
    updates: { name?: string; avatar?: string }
  ): Promise<Chat | null> {
    try {
      const updateData: Record<string, unknown> = {
        updatedAt: Timestamp.now()
      };
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.avatar !== undefined) updateData.avatar = updates.avatar;

      await db.collection(CHATS).doc(chatId).update(updateData);
      const doc = await db.collection(CHATS).doc(chatId).get();
      if (!doc.exists) return null;
      return docToChat(doc.id, doc.data()!);
    } catch {
      return null;
    }
  }

  // Clear cached last-message data for a chat
  static async clearLastMessage(chatId: string): Promise<boolean> {
    try {
      await db.collection(CHATS).doc(chatId).update({
        lastMessageId: null,
        lastMessageData: null,
        updatedAt: Timestamp.now()
      });
      return true;
    } catch {
      return false;
    }
  }

  // Permanently delete a chat document
  static async deleteChat(chatId: string): Promise<boolean> {
    try {
      await db.collection(CHATS).doc(chatId).delete();
      return true;
    } catch {
      return false;
    }
  }
}
