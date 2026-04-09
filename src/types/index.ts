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
  /** Server-only: Web FCM registration tokens; never expose to API clients */
  fcmTokens?: string[];
}

/** 辩论消息元数据（AI 辩手发言） */
export interface DebateMessageMeta {
  side: 'affirmative' | 'negative';
  round: 1 | 2 | 3;
  role: 'first' | 'second' | 'third';
}

export interface DebateConfig {
  topic: string;
  affirmativePersonas: [string, string, string];
  negativePersonas: [string, string, string];
}

export type DebatePhase = 'pending' | 'debating' | 'judging' | 'voting' | 'closed';

export interface DebateState {
  phase: DebatePhase;
  /** 下一待生成回合索引 0–5；辩论未开始或结束后用于展示进度 */
  currentTurnIndex: number;
  votes: Record<string, 'affirmative' | 'negative'>;
  voteCounts?: { affirmative: number; negative: number };
  winner?: 'affirmative' | 'negative' | 'tie';
  /** PigSail 裁判在发言末行 VERDICT:* 解析结果 */
  judgeVerdict?: 'affirmative' | 'negative' | 'tie';
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
  debate?: DebateMessageMeta;
  /** PigSail 辩论裁判发言（非辩手席位） */
  debateJudge?: boolean;
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
  debateConfig?: DebateConfig;
  debateState?: DebateState;
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
  /** AI 辩论群：需同时提供辩题与 6 段人设 */
  debateMode?: boolean;
  debateTopic?: string;
  affirmativePersonas?: string[];
  negativePersonas?: string[];
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

/** 单轮发言顺序：正一→反一→正二→反二→正三→反三 */
export const DEBATE_TURN_SPECS: ReadonlyArray<{ senderId: string; meta: DebateMessageMeta }> = [
  { senderId: 'debate_ai_aff_1', meta: { side: 'affirmative', round: 1, role: 'first' } },
  { senderId: 'debate_ai_neg_1', meta: { side: 'negative', round: 1, role: 'first' } },
  { senderId: 'debate_ai_aff_2', meta: { side: 'affirmative', round: 2, role: 'second' } },
  { senderId: 'debate_ai_neg_2', meta: { side: 'negative', round: 2, role: 'second' } },
  { senderId: 'debate_ai_aff_3', meta: { side: 'affirmative', round: 3, role: 'third' } },
  { senderId: 'debate_ai_neg_3', meta: { side: 'negative', round: 3, role: 'third' } }
];