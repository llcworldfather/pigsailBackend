import { db, Timestamp } from '../utils/firebase';
import { User } from '../types';
import { DocumentData } from 'firebase-admin/firestore';

const USERS = 'users';

function docToUser(id: string, data: DocumentData): User {
  return {
    id,
    username: data.username,
    displayName: data.displayName,
    email: data.email,
    passwordHash: data.passwordHash,
    avatar: data.avatar || undefined,
    status: data.status || 'offline',
    joinedAt: data.joinedAt?.toDate() || new Date(),
    lastSeen: data.lastSeen?.toDate() || new Date()
  };
}

export class UserDAO {
  // Create a new user (id must be provided)
  static async create(userData: Omit<User, 'joinedAt' | 'lastSeen' | 'status'>): Promise<User> {
    const now = Timestamp.now();
    const docData = {
      username: userData.username,
      displayName: userData.displayName,
      email: userData.email || `${userData.username}@example.com`,
      passwordHash: userData.passwordHash,
      avatar: userData.avatar || null,
      status: 'offline',
      joinedAt: now,
      lastSeen: now,
      createdAt: now,
      updatedAt: now
    };

    await db.collection(USERS).doc(userData.id).set(docData);

    return {
      id: userData.id,
      username: docData.username,
      displayName: docData.displayName,
      email: docData.email,
      passwordHash: docData.passwordHash,
      avatar: docData.avatar || undefined,
      status: 'offline',
      joinedAt: now.toDate(),
      lastSeen: now.toDate()
    };
  }

  // Get user by ID
  static async findById(id: string): Promise<User | null> {
    const doc = await db.collection(USERS).doc(id).get();
    if (!doc.exists) return null;
    return docToUser(doc.id, doc.data()!);
  }

  // Get user by username
  static async findByUsername(username: string): Promise<User | null> {
    const snapshot = await db.collection(USERS)
      .where('username', '==', username)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return docToUser(doc.id, doc.data());
  }

  // Get user by email
  static async findByEmail(email: string): Promise<User | null> {
    const snapshot = await db.collection(USERS)
      .where('email', '==', email)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return docToUser(doc.id, doc.data());
  }

  // Get all users ordered by creation time
  static async findAll(): Promise<User[]> {
    const snapshot = await db.collection(USERS)
      .orderBy('createdAt', 'asc')
      .get();
    return snapshot.docs.map(doc => docToUser(doc.id, doc.data()));
  }

  // Update user status
  static async updateStatus(id: string, status: User['status']): Promise<boolean> {
    try {
      await db.collection(USERS).doc(id).update({
        status,
        lastSeen: Timestamp.now(),
        updatedAt: Timestamp.now()
      });
      return true;
    } catch {
      return false;
    }
  }

  // Update last seen timestamp
  static async updateLastSeen(id: string): Promise<boolean> {
    try {
      await db.collection(USERS).doc(id).update({
        lastSeen: Timestamp.now(),
        updatedAt: Timestamp.now()
      });
      return true;
    } catch {
      return false;
    }
  }

  // Get users by status (sorted client-side to avoid composite index requirement)
  static async findByStatus(status: User['status']): Promise<User[]> {
    const snapshot = await db.collection(USERS)
      .where('status', '==', status)
      .get();
    return snapshot.docs
      .map(doc => docToUser(doc.id, doc.data()))
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
  }

  // Update user profile fields
  static async updateProfile(id: string, updates: {
    displayName?: string;
    avatar?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<User | null> {
    const updateData: Record<string, unknown> = { updatedAt: Timestamp.now() };

    if (updates.displayName !== undefined) updateData.displayName = updates.displayName;
    if (updates.avatar !== undefined) updateData.avatar = updates.avatar;
    if (updates.email !== undefined) updateData.email = updates.email;
    if (updates.passwordHash !== undefined) updateData.passwordHash = updates.passwordHash;

    try {
      await db.collection(USERS).doc(id).update(updateData);
      return await this.findById(id);
    } catch {
      return null;
    }
  }

  // Search users by username or displayName (client-side filter — Firestore has no ILIKE)
  static async search(queryString: string, limit: number = 10): Promise<User[]> {
    const q = queryString.toLowerCase();
    const snapshot = await db.collection(USERS).get();
    return snapshot.docs
      .map(doc => docToUser(doc.id, doc.data()))
      .filter(user =>
        user.username.toLowerCase().includes(q) ||
        user.displayName.toLowerCase().includes(q)
      )
      .slice(0, limit);
  }
}
