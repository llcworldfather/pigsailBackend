export interface User {
  id: string;
  username: string;                                   // 账号：用于登录验证
  displayName: string;                                 // 显示名称：聊天中显示的称呼
  email?: string;                                      // 邮箱：可选字段
  avatar?: string;
  status: 'online' | 'offline' | 'away';
  lastSeen: Date;
  joinedAt: Date;
  passwordHash: string;
}

export interface Message {
  id: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  type: 'text' | 'image' | 'file' | 'system';
  readBy: string[];
  isEdited: boolean;
  editedAt?: Date;
  replyToId?: string;
  isDeleted: boolean;
  deletedAt?: Date;
  deletedBy?: string;
  reactions: Record<string, string[]>;
}

export interface Chat {
  id: string;
  name?: string;
  avatar?: string;
  type: 'private' | 'group';
  participants: string[];
  adminId?: string;
  createdAt: Date;
  lastMessage?: Message;
  unreadCounts: Map<string, number>;
}

export interface SocketUser {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  status: 'online' | 'away';
  socketId: string;
}

export interface CreateGroupData {
  name: string;
  participantIds: string[];
  avatar?: string;
}

export interface TypingUser {
  userId: string;
  username: string;
  isTyping: boolean;
  lastTypingTime: Date;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'blocked';

export interface FriendRequest {
  id: string;
  senderId: string;
  recipientId: string;
  status: FriendRequestStatus;
  message: string;
  createdAt: Date;
  updatedAt: Date;
  respondedAt?: Date;
}

export interface RegisterRequest {
  username: string;           // 账号：用于登录验证
  displayName: string;        // 显示名称：聊天中显示的称呼
  password: string;
  email?: string;             // 邮箱：可选字段，系统会自动生成默认值
  avatar?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}