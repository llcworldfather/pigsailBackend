import { db, Timestamp } from '../utils/firebase';
import { DocumentData } from 'firebase-admin/firestore';
import { FriendRequest, FriendRequestStatus } from '../types';

const FRIEND_REQUESTS = 'friend_requests';
const USER_BLOCKS = 'user_blocks';

function docToFriendRequest(id: string, data: DocumentData): FriendRequest {
  return {
    id,
    senderId: data.senderId as string,
    recipientId: data.recipientId as string,
    status: data.status as FriendRequestStatus,
    message: (data.message as string) || '',
    createdAt: data.createdAt?.toDate?.() || new Date(),
    updatedAt: data.updatedAt?.toDate?.() || new Date(),
    respondedAt: data.respondedAt?.toDate?.()
  };
}

export class FriendRequestDAO {
  static async create(data: {
    id: string;
    senderId: string;
    recipientId: string;
    message: string;
  }): Promise<FriendRequest> {
    const now = Timestamp.now();
    const payload = {
      senderId: data.senderId,
      recipientId: data.recipientId,
      status: 'pending' as FriendRequestStatus,
      message: data.message,
      createdAt: now,
      updatedAt: now,
      respondedAt: null
    };

    await db.collection(FRIEND_REQUESTS).doc(data.id).set(payload);
    return docToFriendRequest(data.id, payload);
  }

  static async findPendingBetween(userAId: string, userBId: string): Promise<FriendRequest | null> {
    const [toB, toA] = await Promise.all([
      db.collection(FRIEND_REQUESTS).where('recipientId', '==', userBId).get(),
      db.collection(FRIEND_REQUESTS).where('recipientId', '==', userAId).get()
    ]);

    const allDocs = [...toB.docs, ...toA.docs];
    const match = allDocs.find((doc) => {
      const d = doc.data();
      const senderId = d.senderId as string;
      const recipientId = d.recipientId as string;
      const status = d.status as FriendRequestStatus;
      return (
        status === 'pending' &&
        (
          (senderId === userAId && recipientId === userBId) ||
          (senderId === userBId && recipientId === userAId)
        )
      );
    });

    if (!match) return null;
    return docToFriendRequest(match.id, match.data());
  }

  static async findById(id: string): Promise<FriendRequest | null> {
    const doc = await db.collection(FRIEND_REQUESTS).doc(id).get();
    if (!doc.exists) return null;
    return docToFriendRequest(doc.id, doc.data()!);
  }

  static async findPendingReceivedByUser(userId: string): Promise<FriendRequest[]> {
    const snapshot = await db.collection(FRIEND_REQUESTS)
      .where('recipientId', '==', userId)
      .get();

    return snapshot.docs
      .map((doc) => docToFriendRequest(doc.id, doc.data()))
      .filter((request) => request.status === 'pending')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  static async findBySender(userId: string): Promise<FriendRequest[]> {
    const snapshot = await db.collection(FRIEND_REQUESTS)
      .where('senderId', '==', userId)
      .get();

    return snapshot.docs
      .map((doc) => docToFriendRequest(doc.id, doc.data()))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  static async updateStatus(
    requestId: string,
    status: Exclude<FriendRequestStatus, 'pending'>
  ): Promise<FriendRequest | null> {
    const now = Timestamp.now();
    await db.collection(FRIEND_REQUESTS).doc(requestId).update({
      status,
      updatedAt: now,
      respondedAt: now
    });
    return this.findById(requestId);
  }

  static async blockUser(blockerId: string, blockedId: string): Promise<void> {
    const id = `${blockerId}_${blockedId}`;
    await db.collection(USER_BLOCKS).doc(id).set({
      blockerId,
      blockedId,
      createdAt: Timestamp.now()
    });
  }

  static async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    const id = `${blockerId}_${blockedId}`;
    const doc = await db.collection(USER_BLOCKS).doc(id).get();
    return doc.exists;
  }
}
