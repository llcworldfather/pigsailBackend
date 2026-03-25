import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { dbStorage } from './utils/db-storage';
import { testConnection } from './utils/firebase';
import { verifyToken } from './utils/auth';
import { getPublicServerBase, normalizeAvatarUrl, joinPublicPath } from './utils/public-url';
import {
  pickRandomAvatarUrlFromFirebase,
  resolveAvatarInput,
  warmSystemAvatarUrlsFromFirebase
} from './utils/avatar-storage';
import { ensurePigsailAvatarSynced } from './utils/pigsail-avatar-sync';
import { AIService } from './services/ai-service';
import {
  User,
  Message,
  Chat,
  SocketUser,
  CreateGroupData,
  TypingUser,
  ApiResponse
} from './types';

// Import routes
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';

const app = express();
const server = createServer(app);

// Initialize AI Service
// Set GLM API key directly to bypass .env loading issues
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.warn('⚠️  DEEPSEEK_API_KEY not set in environment — AI responses will use fallback mode');
} else {
  console.log('🔑 DeepSeek API key loaded');
}
const aiService = new AIService({
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: DEEPSEEK_API_KEY
}, dbStorage);

const CHINESE_DIGITS: Record<string, number> = {
  '零': 0,
  '一': 1,
  '二': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9
};

function numberToChinese(num: number): string {
  if (num <= 0) return `${num}`;
  if (num < 10) {
    return Object.entries(CHINESE_DIGITS).find(([, value]) => value === num)?.[0] || `${num}`;
  }
  if (num === 10) return '十';
  if (num < 20) return `十${numberToChinese(num % 10)}`;
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const units = num % 10;
    return `${numberToChinese(tens)}十${units === 0 ? '' : numberToChinese(units)}`;
  }
  return `${num}`;
}

function parseChineseOrArabicNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tensText, unitsText] = value.split('十');
    const tens = tensText ? CHINESE_DIGITS[tensText] : 1;
    const units = unitsText ? CHINESE_DIGITS[unitsText] : 0;
    if (typeof tens === 'number' && typeof units === 'number') {
      return tens * 10 + units;
    }
    return null;
  }
  const direct = CHINESE_DIGITS[value];
  return typeof direct === 'number' ? direct : null;
}

// Allowed origins for CORS (localhost + optional CORS_ORIGINS=comma,separated,urls)
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
  'http://localhost:3005',
  'http://localhost:3006',
  'http://localhost:3007',
  'http://localhost:3008',
  'https://www.pigsail.wtf',
  'https://pigsail.wtf'
];
const extraFromEnv = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...extraFromEnv])];

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

// Serve static files from random folder
app.use('/random', express.static(path.join(__dirname, '../../random')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests, please try again later'
  } as ApiResponse
});

app.use('/api', limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);

// Random avatar endpoint (Firebase avatars/random/* when bucket configured, else local ../random)
app.get('/api/random-avatar', async (req, res) => {
  try {
    const fromFirebase = await pickRandomAvatarUrlFromFirebase();
    if (fromFirebase) {
      return res.json({
        success: true,
        data: {
          avatarUrl: fromFirebase.url,
          filename: fromFirebase.filename
        }
      } as ApiResponse);
    }

    const fs = require('fs');
    const path = require('path');

    const randomFolder = path.join(__dirname, '../../random');

    if (!fs.existsSync(randomFolder)) {
      return res.status(404).json({
        success: false,
        error: 'Random avatars folder not found'
      } as ApiResponse);
    }

    const files = fs.readdirSync(randomFolder).filter((file: string) => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    });

    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No avatar images found in random folder'
      } as ApiResponse);
    }

    const randomFile = files[Math.floor(Math.random() * files.length)];
    const publicBase = getPublicServerBase(req);
    const avatarUrl = joinPublicPath(publicBase, `/random/${randomFile}`);

    res.json({
      success: true,
      data: {
        avatarUrl: avatarUrl,
        filename: randomFile
      }
    } as ApiResponse);
  } catch (error) {
    console.error('Random avatar error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    } as ApiResponse);
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'Server is running',
      timestamp: new Date().toISOString(),
      stats: dbStorage.getStats()
    }
  } as ApiResponse);
});

// Socket.io middleware for authentication
io.use(async (socket, next) => {
  try {
    console.log('Socket authentication attempt - handshake data:', socket.handshake);
    console.log('Socket authentication attempt - auth data:', socket.handshake.auth);

    const token = socket.handshake.auth.token;
    console.log('Extracted token:', token ? 'token exists' : 'no token found');

    if (!token) {
      console.log('Authentication failed: No token provided');
      return next(new Error('Authentication error: No token provided'));
    }

    const decoded = verifyToken(token);
    const user = await dbStorage.getUserById(decoded.id);

    if (!user) {
      console.log('Authentication failed: User not found for token');
      return next(new Error('Authentication error: User not found'));
    }

    console.log('Authentication successful for user:', user.username);
    socket.data.user = user;
    next();
  } catch (error) {
    console.log('Authentication failed: Invalid token', error);
    next(new Error('Authentication error: Invalid token'));
  }
});

// Socket.io connection handling
io.on('connection', async (socket) => {
  const user = socket.data.user as User;
  const publicBase = getPublicServerBase(socket.request);
  const serializeChatOut = (chat: Chat) => {
    const s = dbStorage.serializeChat(chat);
    if (typeof s.avatar === 'string' && s.avatar) {
      s.avatar = normalizeAvatarUrl(s.avatar, publicBase) ?? s.avatar;
    }
    return s;
  };
  const serializeChatsOut = (chats: Chat[]) => chats.map(serializeChatOut);
  const normalizeOnlineUsers = (list: SocketUser[]) =>
    list.map((u) => ({
      ...u,
      avatar: normalizeAvatarUrl(u.avatar, publicBase) ?? u.avatar
    }));

  console.log(`User connected: ${user.displayName} (${user.id})`);
  const getParticipantSocket = (participantId: string) =>
    Array.from(io.sockets.sockets.values()).find(s => s.data.user?.id === participantId);
  const toSafeUser = (targetUser: User) => ({
    id: targetUser.id,
    username: targetUser.username,
    displayName: targetUser.displayName,
    avatar: normalizeAvatarUrl(targetUser.avatar, publicBase) ?? targetUser.avatar,
    email: targetUser.email
  });

  const emitFriendAddedEvent = async (requester: User, recipient: User) => {
    let chat = await dbStorage.getPrivateChat(requester.id, recipient.id);
    let systemMessage: Message | null = null;

    if (!chat) {
      chat = await dbStorage.createChat({
        type: 'private',
        participants: [requester.id, recipient.id]
      });

      systemMessage = {
        id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
        senderId: 'system',
        chatId: chat.id,
        content: '你们已成为好友，开始聊天吧',
        timestamp: new Date(),
        type: 'system',
        readBy: [requester.id, recipient.id],
        isEdited: false,
        isDeleted: false,
        reactions: {}
      };
      await dbStorage.addMessage(systemMessage);
    }

    const pairs: Array<{ viewer: User; friend: User }> = [
      { viewer: requester, friend: recipient },
      { viewer: recipient, friend: requester }
    ];

    pairs.forEach(({ viewer, friend }) => {
      const targetSocket = getParticipantSocket(viewer.id);
      if (!targetSocket || !chat) return;

      const payloadChat = {
        ...serializeChatOut(chat),
        participantsWithInfo: [toSafeUser(requester), toSafeUser(recipient)]
      };

      targetSocket.emit('friend_added', {
        chat: payloadChat,
        friend: toSafeUser(friend),
        systemMessage
      });
    });
  };

  // Add user to online users
  const socketUser: SocketUser = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: normalizeAvatarUrl(user.avatar, publicBase) ?? user.avatar,
    status: 'online',
    socketId: socket.id
  };

  dbStorage.addSocketUser(socketUser);
  await dbStorage.updateUserStatus(user.id, 'online');

  // Broadcast user online status
  socket.broadcast.emit('user_status_changed', {
    userId: user.id,
    status: 'online'
  });

  // Send user's chats - load from database
  try {
    const userChats = await dbStorage.getChatsByUserId(user.id);
    socket.emit('chats_loaded', serializeChatsOut(userChats));
    console.log(`Loaded ${userChats.length} chats for user ${user.displayName}`);
  } catch (error) {
    console.error('Error loading user chats:', error);
    socket.emit('chats_loaded', []);
  }

  // Send online users to current user and broadcast to all others
  const onlineUsers = dbStorage.getOnlineUsers();
  console.log(`Sending online_users to ${user.displayName}:`, onlineUsers.map(u => u.displayName));
  socket.emit('online_users', normalizeOnlineUsers(onlineUsers));

  // Send pending friend requests to the recipient
  try {
    const pendingRequests = await dbStorage.getPendingReceivedFriendRequests(user.id);
    const requestPayload = await Promise.all(
      pendingRequests.map(async (request) => {
        const sender = await dbStorage.getUserById(request.senderId);
        return {
          ...request,
          sender: sender ? toSafeUser(sender) : null
        };
      })
    );
    socket.emit('friend_requests_loaded', requestPayload.filter(item => item.sender));
  } catch (error) {
    console.error('Load friend requests error:', error);
    socket.emit('friend_requests_loaded', []);
  }

  // Send friend requests that this user has sent (for status tracking)
  try {
    const sentRequests = await dbStorage.getSentFriendRequests(user.id);
    const sentPayload = await Promise.all(
      sentRequests.map(async (request) => {
        const recipient = await dbStorage.getUserById(request.recipientId);
        return {
          ...request,
          recipient: recipient ? toSafeUser(recipient) : null
        };
      })
    );
    socket.emit('friend_sent_requests_loaded', sentPayload.filter(item => item.recipient));
  } catch (error) {
    console.error('Load sent friend requests error:', error);
    socket.emit('friend_sent_requests_loaded', []);
  }

  // 稍微延迟广播在线用户列表，确保新用户的连接状态完全建立
  setTimeout(() => {
    const latestOnlineUsers = dbStorage.getOnlineUsers();
    console.log('Broadcasting updated online users list after new connection:', latestOnlineUsers.map(u => u.displayName));
    io.emit('online_users', normalizeOnlineUsers(latestOnlineUsers));
  }, 50);

  // Get or create private chat
  socket.on('get_private_chat', async (recipientId: string) => {
    try {
      let chat = await dbStorage.getPrivateChat(user.id, recipientId);

      if (!chat) {
        // Create new private chat
        chat = await dbStorage.createChat({
          type: 'private',
          participants: [user.id, recipientId]
        });
      }

      const messages = await dbStorage.getMessagesByChatId(chat.id);
      const recipient = await dbStorage.getUserById(recipientId);

      socket.emit('private_chat_loaded', {
        chat: serializeChatOut(chat),
        messages,
        recipient: recipient ? {
          id: recipient.id,
          username: recipient.username,
          displayName: recipient.displayName,
          avatar: normalizeAvatarUrl(recipient.avatar, publicBase) ?? recipient.avatar,
          status: recipient.status
        } : null
      });

    } catch (error) {
      console.error('Get private chat error:', error);
      socket.emit('error', { message: 'Failed to load private chat' });
    }
  });

  // Load messages for a specific chat（支持 aroundMessageId 用于搜索跳转到具体消息）
  socket.on('get_chat_messages', async (data: string | { chatId: string; aroundMessageId?: string }) => {
    try {
      const chatId = typeof data === 'string' ? data : data.chatId;
      const aroundMessageId = typeof data === 'object' ? data.aroundMessageId : undefined;
      console.log('[Server] get_chat_messages 收到:', { dataType: typeof data, chatId, aroundMessageId, rawData: data });

      const chat = await dbStorage.getChatById(chatId);
      if (!chat || !chat.participants.includes(user.id)) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      const messages = await dbStorage.getMessagesByChatId(chat.id, 50, aroundMessageId);
      console.log('[Server] 加载消息结果:', { chatId: chat.id, aroundMessageId, messageCount: messages.length, firstIds: messages.slice(0, 3).map(m => m.id), lastIds: messages.slice(-3).map(m => m.id) });
      let recipient: any = null;

      if (chat.type === 'private') {
        const recipientId = chat.participants.find(pid => pid !== user.id);
        if (recipientId) {
          const recipientUser = await dbStorage.getUserById(recipientId);
          if (recipientUser) {
            recipient = {
              id: recipientUser.id,
              username: recipientUser.username,
              displayName: recipientUser.displayName,
              avatar: normalizeAvatarUrl(recipientUser.avatar, publicBase) ?? recipientUser.avatar,
              status: recipientUser.status
            };
          }
        }
      }

      socket.emit('chat_messages_loaded', {
        chat: serializeChatOut(chat),
        messages,
        recipient
      });
    } catch (error) {
      console.error('Get chat messages error:', error);
      socket.emit('error', { message: 'Failed to load chat messages' });
    }
  });

  // Load older messages than a given anchor (pagination for upward scrolling)
  socket.on(
    'load_older_messages',
    async (
      data: { chatId: string; beforeMessageId: string; limit?: number },
      callback?: (res: { success?: boolean; messages?: Message[]; hasMore?: boolean; error?: string }) => void
    ) => {
      const respond = (payload: { success?: boolean; messages?: Message[]; hasMore?: boolean; error?: string }) => {
        if (callback) callback(payload);
      };

      try {
        const chatId = data?.chatId;
        const beforeMessageId = data?.beforeMessageId;
        if (!chatId || !beforeMessageId) {
          respond({ error: '缺少参数' });
          return;
        }

        const chat = await dbStorage.getChatById(chatId);
        if (!chat || !chat.participants.includes(user.id)) {
          respond({ error: 'Chat not found or access denied' });
          return;
        }

        const limit = typeof data.limit === 'number' && data.limit > 0 ? Math.min(data.limit, 100) : 30;
        const result = await dbStorage.getMessagesBeforeMessage(chatId, beforeMessageId, limit);
        respond({ success: true, messages: result.messages, hasMore: result.hasMore });
      } catch (error) {
        console.error('Load older messages error:', error);
        respond({ error: 'Failed to load older messages' });
      }
    }
  );

  // 预览上下文：以某条消息为「最新一条」，仅用于弹窗，不触发 chat_messages_loaded
  socket.on(
    'preview_chat_messages',
    async (
      data: { chatId: string; endingAtMessageId: string; limit?: number },
      callback?: (res: { success?: boolean; messages?: any[]; error?: string }) => void
    ) => {
      const respond = (payload: { success?: boolean; messages?: any[]; error?: string }) => {
        if (callback) callback(payload);
      };
      try {
        const chatId = data?.chatId;
        const endingAtMessageId = data?.endingAtMessageId;
        if (!chatId || !endingAtMessageId) {
          respond({ error: '缺少参数' });
          return;
        }
        const chat = await dbStorage.getChatById(chatId);
        if (!chat || !chat.participants.includes(user.id)) {
          respond({ error: 'Chat not found or access denied' });
          return;
        }
        const limit = typeof data.limit === 'number' && data.limit > 0 ? Math.min(data.limit, 200) : 50;
        const messages = await dbStorage.getMessagesEndingAtMessage(chat.id, endingAtMessageId, limit);
        respond({ success: true, messages });
      } catch (error) {
        console.error('Preview chat messages error:', error);
        respond({ error: 'Failed to load messages' });
      }
    }
  );

  // Create a brand new PigSail private session
  socket.on('create_pigsail_chat', async (callback?: (data: unknown) => void) => {
    try {
      const pigsailUser = await dbStorage.getUserByUsername('pigsail');
      if (!pigsailUser) {
        if (callback) callback({ error: 'PigSail 用户不存在' });
        return;
      }

      const allChats = await dbStorage.getChatsByUserId(user.id);
      const pigsailChats = allChats.filter(chat =>
        chat.type === 'private' && chat.participants.includes(pigsailUser.id)
      );

      let maxIndex = 0;
      pigsailChats.forEach(chat => {
        if (!chat.name) return;
        const match = chat.name.match(/^PigSail(.+)号$/i);
        if (!match) return;
        const parsed = parseChineseOrArabicNumber(match[1]);
        if (parsed && parsed > maxIndex) {
          maxIndex = parsed;
        }
      });

      const nextIndex = maxIndex + 1;
      const chatName = `PigSail${numberToChinese(nextIndex)}号`;

      const chat = await dbStorage.createChat({
        type: 'private',
        name: chatName,
        participants: [user.id, pigsailUser.id]
      });

      const welcomeMessage: Message = {
        id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
        senderId: pigsailUser.id,
        chatId: chat.id,
        content: 'pigsail驾到通通闪开',
        timestamp: new Date(),
        type: 'text',
        readBy: [pigsailUser.id],
        isEdited: false,
        isDeleted: false,
        reactions: {}
      };
      await dbStorage.addMessage(welcomeMessage);
      await dbStorage.updateChatLastMessage(chat.id, welcomeMessage);
      const latestChat = await dbStorage.getChatById(chat.id);

      const payload = {
        chat: serializeChatOut(latestChat || chat),
        messages: [welcomeMessage],
        recipient: {
          id: pigsailUser.id,
          username: pigsailUser.username,
          displayName: pigsailUser.displayName,
          avatar: normalizeAvatarUrl(pigsailUser.avatar, publicBase) ?? pigsailUser.avatar,
          status: pigsailUser.status
        }
      };

      if (callback) callback(payload);
    } catch (error) {
      console.error('Create pigsail chat error:', error);
      if (callback) callback({ error: '创建 PigSail 对话失败' });
    }
  });

  // Send friend request (do not create chat until accepted)
  socket.on('add_friend', async (friendName: string, callback?: (data: unknown) => void) => {
    try {
      const allUsers = await dbStorage.getAllUsers();
      const friendUser = allUsers.find(u =>
        u.displayName === friendName || u.username === friendName
      );

      if (!friendUser) {
        socket.emit('error', { message: 'User not found' });
        if (callback) callback({ error: 'User not found' });
        return;
      }

      if (friendUser.id === user.id) {
        socket.emit('error', { message: 'Cannot add yourself as a friend' });
        if (callback) callback({ error: 'Cannot add yourself as a friend' });
        return;
      }

      // Respect block list in both directions.
      const blockedByTarget = await dbStorage.isUserBlocked(friendUser.id, user.id);
      const blockedByRequester = await dbStorage.isUserBlocked(user.id, friendUser.id);
      if (blockedByTarget || blockedByRequester) {
        if (callback) callback({ error: '无法发送好友申请' });
        return;
      }

      // If already friends, return current chat info.
      const existingChat = await dbStorage.getPrivateChat(user.id, friendUser.id);
      if (existingChat) {
        if (callback) callback({
          alreadyFriends: true,
          chat: serializeChatOut(existingChat),
          friend: toSafeUser(friendUser)
        });
        return;
      }

      const existingPending = await dbStorage.getPendingFriendRequestBetween(user.id, friendUser.id);
      if (existingPending) {
        if (callback) callback({ error: '好友申请已存在，等待对方处理' });
        return;
      }

      const request = await dbStorage.createFriendRequest(
        user.id,
        friendUser.id,
        `${user.displayName} 向你发送了好友申请`
      );

      const recipientSocket = getParticipantSocket(friendUser.id);
      const requestPayload = {
        ...request,
        sender: toSafeUser(user)
      };
      if (recipientSocket) {
        recipientSocket.emit('friend_request_received', requestPayload);
        recipientSocket.emit('new_message', {
          id: request.id,
          senderId: 'system',
          chatId: '',
          content: `${user.displayName} 向你发送了好友申请`,
          timestamp: new Date(),
          type: 'system',
          readBy: [friendUser.id],
          isEdited: false,
          isDeleted: false,
          reactions: {}
        } as Message);
      }

      if (callback) callback({
        success: true,
        request: {
          ...request,
          recipient: toSafeUser(friendUser)
        }
      });
    } catch (error) {
      console.error('Add friend error:', error);
      socket.emit('error', { message: 'Failed to send friend request' });
      if (callback) callback({ error: 'Failed to send friend request' });
    }
  });

  socket.on('get_friend_requests', async (callback?: (data: unknown) => void) => {
    try {
      const pendingRequests = await dbStorage.getPendingReceivedFriendRequests(user.id);
      const requestPayload = await Promise.all(
        pendingRequests.map(async (request) => {
          const sender = await dbStorage.getUserById(request.senderId);
          return {
            ...request,
            sender: sender ? toSafeUser(sender) : null
          };
        })
      );
      if (callback) callback({ requests: requestPayload.filter(item => item.sender) });
    } catch (error) {
      console.error('Get friend requests error:', error);
      if (callback) callback({ error: 'Failed to load friend requests' });
    }
  });

  socket.on('get_sent_friend_requests', async (callback?: (data: unknown) => void) => {
    try {
      const sentRequests = await dbStorage.getSentFriendRequests(user.id);
      const sentPayload = await Promise.all(
        sentRequests.map(async (request) => {
          const recipient = await dbStorage.getUserById(request.recipientId);
          return {
            ...request,
            recipient: recipient ? toSafeUser(recipient) : null
          };
        })
      );
      if (callback) callback({ requests: sentPayload.filter(item => item.recipient) });
    } catch (error) {
      console.error('Get sent friend requests error:', error);
      if (callback) callback({ error: 'Failed to load sent friend requests' });
    }
  });

  socket.on(
    'handle_friend_request',
    async (
      data: { requestId: string; action: 'accept' | 'reject' | 'block' },
      callback?: (res: unknown) => void
    ) => {
      try {
        const request = await dbStorage.getFriendRequestById(data.requestId);
        if (!request || request.recipientId !== user.id || request.status !== 'pending') {
          if (callback) callback({ error: '好友申请不存在或已处理' });
          return;
        }

        const senderUser = await dbStorage.getUserById(request.senderId);
        if (!senderUser) {
          if (callback) callback({ error: '发送方用户不存在' });
          return;
        }

        if (data.action === 'accept') {
          await dbStorage.updateFriendRequestStatus(request.id, 'accepted');
          await emitFriendAddedEvent(senderUser, user);
          const senderSocket = getParticipantSocket(senderUser.id);
          if (senderSocket) {
            senderSocket.emit('friend_request_handled', {
              requestId: request.id,
              action: 'accepted',
              byUser: toSafeUser(user)
            });
          }
          if (callback) callback({ success: true, action: 'accepted', requestId: request.id });
          return;
        }

        if (data.action === 'reject') {
          await dbStorage.updateFriendRequestStatus(request.id, 'rejected');
          const senderSocket = getParticipantSocket(senderUser.id);
          if (senderSocket) {
            senderSocket.emit('friend_request_handled', {
              requestId: request.id,
              action: 'rejected',
              byUser: toSafeUser(user)
            });
          }
          if (callback) callback({ success: true, action: 'rejected', requestId: request.id });
          return;
        }

        await dbStorage.updateFriendRequestStatus(request.id, 'blocked');
        await dbStorage.blockUser(user.id, senderUser.id);
        const senderSocket = getParticipantSocket(senderUser.id);
        if (senderSocket) {
          senderSocket.emit('friend_request_handled', {
            requestId: request.id,
            action: 'blocked',
            byUser: toSafeUser(user)
          });
        }
        if (callback) callback({ success: true, action: 'blocked', requestId: request.id });
      } catch (error) {
        console.error('Handle friend request error:', error);
        if (callback) callback({ error: '处理好友申请失败' });
      }
    }
  );

  // Remove friendship for a private chat (both sides removed)
  socket.on('remove_friend', async (friendId: string, callback?: (data: unknown) => void) => {
    try {
      const chat = await dbStorage.getPrivateChat(user.id, friendId);
      if (!chat) {
        if (callback) callback({ error: '好友关系不存在' });
        return;
      }

      await dbStorage.clearMessagesByChatId(chat.id);
      await dbStorage.deleteChat(chat.id);

      [user.id, friendId].forEach(participantId => {
        const participantSocket = getParticipantSocket(participantId);
        if (participantSocket) {
          participantSocket.emit('friend_removed', {
            chatId: chat.id,
            friendId: participantId === user.id ? friendId : user.id
          });
        }
      });

      if (callback) callback({ success: true, chatId: chat.id });
    } catch (error) {
      console.error('Remove friend error:', error);
      if (callback) callback({ error: '删除好友失败' });
      socket.emit('error', { message: 'Failed to remove friend' });
    }
  });

  // Clear all messages in a chat while keeping friendship
  socket.on('clear_chat_messages', async (chatId: string, callback?: (data: unknown) => void) => {
    try {
      const chat = await dbStorage.getChatById(chatId);
      if (!chat || !chat.participants.includes(user.id)) {
        if (callback) callback({ error: 'Chat not found or access denied' });
        return;
      }

      await dbStorage.clearMessagesByChatId(chatId);
      await dbStorage.clearChatLastMessage(chatId);

      chat.participants.forEach(participantId => {
        const participantSocket = getParticipantSocket(participantId);
        if (participantSocket) {
          participantSocket.emit('chat_cleared', {
            chatId,
            clearedBy: user.id
          });
        }
      });

      if (callback) callback({ success: true, chatId });
    } catch (error) {
      console.error('Clear chat messages error:', error);
      if (callback) callback({ error: '清空聊天记录失败' });
      socket.emit('error', { message: 'Failed to clear chat messages' });
    }
  });

  // Create group chat
  socket.on('create_group', async (groupData: CreateGroupData) => {
    try {
      const participantIds = [user.id, ...groupData.participantIds];

      const chat = await dbStorage.createChat({
        type: 'group',
        name: groupData.name,
        avatar: groupData.avatar,
        participants: participantIds,
        adminId: user.id
      });

      // Send system message
      const systemMessage: Message = {
        id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
        senderId: 'system',
        chatId: chat.id,
        content: `${user.displayName} created the group "${chat.name}"`,
        timestamp: new Date(),
        type: 'system',
        readBy: participantIds,
        isEdited: false,
        isDeleted: false,
        reactions: {}
      };

      await dbStorage.addMessage(systemMessage);

      // Notify all participants
      participantIds.forEach(participantId => {
        const participantSocket = Array.from(io.sockets.sockets.values())
          .find(s => s.data.user?.id === participantId);

        if (participantSocket) {
          participantSocket.emit('group_created', serializeChatOut(chat));
          participantSocket.emit('new_message', systemMessage);
        }
      });

      socket.emit('group_created_success', serializeChatOut(chat));

    } catch (error) {
      console.error('Create group error:', error);
      socket.emit('error', { message: 'Failed to create group' });
    }
  });

  // Add members to an existing group chat (admin only)
  socket.on(
    'add_group_members',
    async (
      data: { chatId: string; memberIds: string[] },
      callback?: (payload: unknown) => void
    ) => {
      try {
        const chat = await dbStorage.getChatById(data.chatId);
        if (!chat || chat.type !== 'group' || !chat.participants.includes(user.id)) {
          if (callback) callback({ error: 'Chat not found or access denied' });
          return;
        }

        if (chat.adminId && chat.adminId !== user.id) {
          if (callback) callback({ error: 'Only group admin can add members' });
          return;
        }

        const uniqueIds = Array.from(new Set((data.memberIds || []).filter(Boolean)));
        const candidateIds = uniqueIds.filter(id => !chat.participants.includes(id));
        if (candidateIds.length === 0) {
          if (callback) callback({ error: 'No new members to add' });
          return;
        }

        const validIds: string[] = [];
        for (const memberId of candidateIds) {
          const targetUser = await dbStorage.getUserById(memberId);
          if (!targetUser) continue;
          await dbStorage.addParticipantToChat(chat.id, memberId);
          validIds.push(memberId);
        }

        if (validIds.length === 0) {
          if (callback) callback({ error: 'No valid members to add' });
          return;
        }

        const updatedChat = await dbStorage.getChatById(chat.id);
        if (!updatedChat) {
          if (callback) callback({ error: 'Failed to load updated chat' });
          return;
        }

        const addedUsers = await Promise.all(validIds.map(id => dbStorage.getUserById(id)));
        const addedNames = addedUsers
          .filter((u): u is User => !!u)
          .map(u => u.displayName);

        const systemMessage: Message = {
          id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
          senderId: 'system',
          chatId: updatedChat.id,
          content: `${user.displayName} 邀请了 ${addedNames.join('、')} 加入群聊`,
          timestamp: new Date(),
          type: 'system',
          readBy: updatedChat.participants,
          isEdited: false,
          isDeleted: false,
          reactions: {}
        };
        await dbStorage.addMessage(systemMessage);

        updatedChat.participants.forEach(participantId => {
          const participantSocket = getParticipantSocket(participantId);
          if (!participantSocket) return;

          // For newly added users, ensure the chat appears in list immediately.
          if (validIds.includes(participantId)) {
            participantSocket.emit('group_created', serializeChatOut(updatedChat));
          } else {
            participantSocket.emit('group_profile_updated', serializeChatOut(updatedChat));
          }
          participantSocket.emit('new_message', systemMessage);
        });

        if (callback) callback({ success: true, chat: serializeChatOut(updatedChat), addedMemberIds: validIds });
      } catch (error) {
        console.error('Add group members error:', error);
        if (callback) callback({ error: 'Failed to add group members' });
      }
    }
  );

  // Remove a member from group chat (admin only)
  socket.on(
    'remove_group_member',
    async (
      data: { chatId: string; memberId: string },
      callback?: (payload: unknown) => void
    ) => {
      try {
        const chat = await dbStorage.getChatById(data.chatId);
        if (!chat || chat.type !== 'group' || !chat.participants.includes(user.id)) {
          if (callback) callback({ error: 'Chat not found or access denied' });
          return;
        }

        if (chat.adminId && chat.adminId !== user.id) {
          if (callback) callback({ error: 'Only group admin can remove members' });
          return;
        }

        if (!chat.participants.includes(data.memberId)) {
          if (callback) callback({ error: 'Target member is not in this group' });
          return;
        }

        if (data.memberId === user.id) {
          if (callback) callback({ error: 'Please use leave group to exit yourself' });
          return;
        }

        await dbStorage.removeParticipantFromChat(chat.id, data.memberId);
        const removedUser = await dbStorage.getUserById(data.memberId);
        const updatedChat = await dbStorage.getChatById(chat.id);

        if (!updatedChat) {
          if (callback) callback({ error: 'Failed to load updated chat' });
          return;
        }

        const systemMessage: Message = {
          id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
          senderId: 'system',
          chatId: updatedChat.id,
          content: `${removedUser?.displayName || '某成员'} 被 ${user.displayName} 移出了群聊`,
          timestamp: new Date(),
          type: 'system',
          readBy: updatedChat.participants,
          isEdited: false,
          isDeleted: false,
          reactions: {}
        };
        await dbStorage.addMessage(systemMessage);

        updatedChat.participants.forEach(participantId => {
          const participantSocket = getParticipantSocket(participantId);
          if (!participantSocket) return;
          participantSocket.emit('group_profile_updated', serializeChatOut(updatedChat));
          participantSocket.emit('user_left_group', {
            chatId: updatedChat.id,
            userId: data.memberId,
            message: systemMessage
          });
          participantSocket.emit('new_message', systemMessage);
        });

        const removedSocket = getParticipantSocket(data.memberId);
        if (removedSocket) {
          removedSocket.emit('left_group', { chatId: updatedChat.id });
        }

        if (callback) callback({ success: true, chat: serializeChatOut(updatedChat), removedMemberId: data.memberId });
      } catch (error) {
        console.error('Remove group member error:', error);
        if (callback) callback({ error: 'Failed to remove group member' });
      }
    }
  );

  // Update group profile (admin only): name/avatar
  socket.on(
    'update_group_profile',
    async (
      data: { chatId: string; name?: string; avatar?: string },
      callback?: (payload: unknown) => void
    ) => {
      try {
        const chat = await dbStorage.getChatById(data.chatId);
        if (!chat || chat.type !== 'group' || !chat.participants.includes(user.id)) {
          if (callback) callback({ error: 'Chat not found or access denied' });
          return;
        }

        if (chat.adminId && chat.adminId !== user.id) {
          if (callback) callback({ error: 'Only group admin can update group profile' });
          return;
        }

        const updates: { name?: string; avatar?: string } = {};
        if (typeof data.name === 'string') updates.name = data.name.trim();
        if (typeof data.avatar === 'string') {
          updates.avatar = await resolveAvatarInput(
            data.avatar,
            { userId: user.id, kind: 'group', groupId: data.chatId },
            publicBase
          );
        }

        if (updates.name !== undefined && !updates.name) {
          if (callback) callback({ error: 'Group name cannot be empty' });
          return;
        }

        const updatedChat = await dbStorage.updateGroupChatProfile(data.chatId, updates);
        if (!updatedChat) {
          if (callback) callback({ error: 'Failed to update group profile' });
          return;
        }

        chat.participants.forEach(participantId => {
          const participantSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.data.user?.id === participantId);
          if (participantSocket) {
            participantSocket.emit('group_profile_updated', serializeChatOut(updatedChat));
          }
        });

        if (callback) callback({ success: true, chat: serializeChatOut(updatedChat) });
      } catch (error) {
        console.error('Update group profile error:', error);
        if (callback) callback({ error: 'Failed to update group profile' });
      }
    }
  );

  // Send message
  socket.on('send_message', async (messageData: { chatId: string; content: string; type?: string; replyToId?: string }) => {
    try {
      const chat = await dbStorage.getChatById(messageData.chatId);
      if (!chat || !chat.participants.includes(user.id)) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      if (messageData.replyToId) {
        const replyTarget = await dbStorage.getMessageById(messageData.replyToId);
        if (!replyTarget || replyTarget.chatId !== messageData.chatId) {
          socket.emit('error', { message: 'Reply target message not found' });
          return;
        }
      }

      const message: Message = {
        id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
        senderId: user.id,
        chatId: messageData.chatId,
        content: messageData.content,
        timestamp: new Date(),
        type: (messageData.type as any) || 'text',
        readBy: [user.id],
        isEdited: false,
        isDeleted: false,
        replyToId: messageData.replyToId,
        reactions: {}
      };

      await dbStorage.addMessage(message);

      // Send to all participants in the chat
      chat.participants.forEach(participantId => {
        const participantSocket = Array.from(io.sockets.sockets.values())
          .find(s => s.data.user?.id === participantId);

        if (participantSocket) {
          participantSocket.emit('new_message', message);
        }
      });

      // Mention notifications: @displayName / @username in group chat
      if (chat.type === 'group') {
        const mentionMatches = Array.from((messageData.content || '').matchAll(/@([^\s@,，.!！？:：;；]+)/g));
        const mentionTokens = Array.from(new Set(mentionMatches.map(m => (m[1] || '').trim().toLowerCase()).filter(Boolean)));

        const participantUsers = await Promise.all(
          chat.participants.map(async (participantId: string) => dbStorage.getUserById(participantId))
        );
        const validUsers = participantUsers.filter((u: User | undefined): u is User => !!u);

        const mentionedUserIds = new Set<string>();
        mentionTokens.forEach((token) => {
          const hit = validUsers.find((u) =>
            (u.username || '').toLowerCase() === token ||
            (u.displayName || '').toLowerCase() === token
          );
          if (hit) mentionedUserIds.add(hit.id);
        });

        for (const mentionedUserId of mentionedUserIds) {
          if (mentionedUserId === user.id) continue;
          const mentionedSocket = getParticipantSocket(mentionedUserId);
          if (mentionedSocket) {
            mentionedSocket.emit('mentioned_in_chat', {
              chatId: chat.id,
              messageId: message.id,
              fromUserId: user.id,
              fromDisplayName: user.displayName,
              fromUsername: user.username,
              chatName: chat.name || '群聊',
              contentPreview: message.content.slice(0, 120),
              timestamp: new Date()
            });
          }
        }
      }

      // AI Response Logic — streaming version
      try {
        const shouldRespond = await aiService.shouldGenerateAIResponse(message, chat, user);
        if (shouldRespond) {
          console.log(`🤖 AI streaming response for ${user.displayName}: "${message.content.substring(0, 50)}..."`);

          const pigsailUser = await dbStorage.getUserByUsername('pigsail');
          if (pigsailUser) {
            const msgId = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
            const placeholderMsg: Message = {
              id: msgId,
              senderId: pigsailUser.id,
              chatId: messageData.chatId,
              content: '',
              timestamp: new Date(),
              type: 'text',
              readBy: [pigsailUser.id],
              isEdited: false,
              isDeleted: false,
              reactions: {}
            };

            // Broadcast a helper to all chat participants
            const emitToChat = (event: string, data: unknown) => {
              chat.participants.forEach(pid => {
                const sock = Array.from(io.sockets.sockets.values()).find(s => s.data.user?.id === pid);
                if (sock) sock.emit(event, data);
              });
            };

            // Short thinking pause, then start streaming
            setTimeout(async () => {
              emitToChat('ai_stream_start', { message: placeholderMsg });

              let fullContent = '';
              try {
                fullContent = await aiService.generateStreamResponse(
                  message, chat, user,
                  (chunk: string) => emitToChat('ai_stream_chunk', { messageId: msgId, chatId: messageData.chatId, chunk })
                );
              } catch (streamErr) {
                console.error('AI stream error:', streamErr);
                fullContent = '（人家的网抽风了啦！！！💀 等一下下！(╯°□°）╯）';
                emitToChat('ai_stream_chunk', { messageId: msgId, chatId: messageData.chatId, chunk: fullContent });
              }

              const finalMsg: Message = { ...placeholderMsg, content: fullContent };
              await dbStorage.addMessage(finalMsg);
              await dbStorage.updateChatLastMessage(chat.id, finalMsg);
              emitToChat('ai_stream_end', { message: finalMsg });
            }, 600);
          }
        }
      } catch (aiError) {
        console.error('AI response error:', aiError);
      }

    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Delete message
  socket.on('delete_message', async (data: { messageId: string; chatId: string }) => {
    try {
      const chat = await dbStorage.getChatById(data.chatId);
      if (!chat || !chat.participants.includes(user.id)) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      // Check if user is the sender of the message
      const message = await dbStorage.getMessagesByChatId(data.chatId, 1000);
      const targetMessage = message.find(m => m.id === data.messageId);

      if (!targetMessage) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }

      if (targetMessage.senderId !== user.id) {
        socket.emit('error', { message: 'You can only delete your own messages' });
        return;
      }

      const success = await dbStorage.deleteMessage(data.messageId, user.id);

      if (success) {
        // Create a deleted message object to broadcast
        const deletedMessage = {
          ...targetMessage,
          content: '[Message deleted]',
          type: 'system',
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: user.id
        };

        // Send to all participants in the chat
        chat.participants.forEach(participantId => {
          const participantSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.data.user?.id === participantId);

          if (participantSocket) {
            participantSocket.emit('message_deleted', deletedMessage);
          }
        });
      } else {
        socket.emit('error', { message: 'Failed to delete message' });
      }

    } catch (error) {
      console.error('Delete message error:', error);
      socket.emit('error', { message: 'Failed to delete message' });
    }
  });

  // Toggle emoji reaction on a message
  socket.on('toggle_reaction', async (data: { chatId: string; messageId: string; emoji: string }) => {
    try {
      const chat = await dbStorage.getChatById(data.chatId);
      if (!chat || !chat.participants.includes(user.id)) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      const targetMessage = await dbStorage.getMessageById(data.messageId);
      if (!targetMessage || targetMessage.chatId !== data.chatId) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }

      const emoji = (data.emoji || '').trim();
      if (!emoji) {
        socket.emit('error', { message: 'Invalid emoji' });
        return;
      }

      const updatedMessage = await dbStorage.toggleMessageReaction(data.messageId, emoji, user.id);
      if (!updatedMessage) {
        socket.emit('error', { message: 'Failed to update message reaction' });
        return;
      }

      chat.participants.forEach(participantId => {
        const participantSocket = Array.from(io.sockets.sockets.values())
          .find(s => s.data.user?.id === participantId);

        if (participantSocket) {
          participantSocket.emit('message_reaction_updated', updatedMessage);
        }
      });
    } catch (error) {
      console.error('Toggle reaction error:', error);
      socket.emit('error', { message: 'Failed to update message reaction' });
    }
  });

  // Search messages
  socket.on('search_messages', async (data: { chatId: string; query: string }, callback) => {
    try {
      const chat = await dbStorage.getChatById(data.chatId);
      if (!chat || !chat.participants.includes(user.id)) {
        callback({ error: 'Chat not found or access denied' });
        return;
      }

      const searchResults = await dbStorage.searchMessages(data.chatId, data.query);
      callback({ success: true, data: searchResults });

    } catch (error) {
      console.error('Search messages error:', error);
      callback({ error: 'Failed to search messages' });
    }
  });

  // 全局搜索聊天记录（类似微信）
  socket.on('search_messages_global', async (data: { query: string }, callback) => {
    try {
      const q = (data.query || '').trim();
      if (!q) {
        callback({ success: true, data: [] });
        return;
      }
      const searchResults = await dbStorage.searchMessagesGlobal(user.id, q);
      callback({ success: true, data: searchResults });
    } catch (error) {
      console.error('Search messages global error:', error);
      callback({ error: 'Failed to search messages' });
    }
  });

  // 群聊消息摘要：流式推送（避免长时间等待导致 ack 无响应；实时显示打字效果）
  socket.on(
    'summarize_group_chat',
    async (data: { chatId: string; requestId?: string; stream?: boolean }, callback?: (res: unknown) => void) => {
      const requestId =
        data?.requestId || `gsum_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const useStream = data?.stream !== false;

      const fail = (msg: string) => {
        if (useStream) {
          socket.emit('group_summary_stream_error', { chatId: data?.chatId || '', requestId, message: msg });
        } else if (callback) {
          callback({ error: msg });
        }
      };

      try {
        const chatId = data?.chatId;
        if (!chatId) {
          fail('缺少 chatId');
          return;
        }

        const chat = await dbStorage.getChatById(chatId);
        if (!chat || chat.type !== 'group' || !chat.participants.includes(user.id)) {
          fail('群聊不存在或无权访问');
          return;
        }

        const messages = await dbStorage.getLastMessagesForSummary(chatId, 100);

        const senderIds = [...new Set(messages.map(m => m.senderId).filter(id => id !== 'system'))];
        const senderDisplayNames = new Map<string, string>();
        for (const sid of senderIds) {
          const u = await dbStorage.getUserById(sid);
          senderDisplayNames.set(sid, u?.displayName || u?.username || sid);
        }
        senderDisplayNames.set('system', '系统');

        if (!useStream) {
          const summary = await aiService.summarizeGroupMessages(
            messages,
            chat.name || '群聊',
            senderDisplayNames
          );
          if (callback) callback({ success: true, summary });
          return;
        }

        const cid = String(chatId);
        const rid = String(requestId);

        socket.emit('group_summary_stream_start', { chatId: cid, requestId: rid });

        await aiService.summarizeGroupMessagesStream(
          messages,
          chat.name || '群聊',
          senderDisplayNames,
          (chunk: string) => {
            if (chunk) {
              socket.emit('group_summary_stream_chunk', { chatId: cid, requestId: rid, chunk });
            }
          }
        );

        socket.emit('group_summary_stream_end', { chatId: cid, requestId: rid });
      } catch (error) {
        console.error('Summarize group chat error:', error);
        fail('摘要生成失败，请稍后重试');
      }
    }
  );

  // Mark messages as read
  socket.on('mark_messages_read', async (chatId: string) => {
    try {
      await dbStorage.markMessagesAsRead(chatId, user.id);

      // Notify other participants that messages were read
      const chat = await dbStorage.getChatById(chatId);
      if (chat) {
        chat.participants.forEach(participantId => {
          if (participantId !== user.id) {
            const participantSocket = Array.from(io.sockets.sockets.values())
              .find(s => s.data.user?.id === participantId);

            if (participantSocket) {
              participantSocket.emit('messages_read', {
                chatId,
                userId: user.id
              });
            }
          }
        });
      }

    } catch (error) {
      console.error('Mark messages read error:', error);
    }
  });

  // Typing indicators
  socket.on('typing_start', async (chatId: string) => {
    const typingUser: TypingUser = {
      userId: user.id,
      username: user.displayName,
      isTyping: true,
      lastTypingTime: new Date()
    };

    dbStorage.setTypingUser(chatId, typingUser);

    // Notify other participants in the chat
    const chat = await dbStorage.getChatById(chatId);
    if (chat) {
      chat.participants.forEach(participantId => {
        if (participantId !== user.id) {
          const participantSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.data.user?.id === participantId);

          if (participantSocket) {
            participantSocket.emit('user_typing', {
              chatId,
              user: typingUser
            });
          }
        }
      });
    }
  });

  socket.on('typing_stop', async (chatId: string) => {
    dbStorage.removeTypingUser(chatId, user.id);

    // Notify other participants
    const chat = await dbStorage.getChatById(chatId);
    if (chat) {
      chat.participants.forEach(participantId => {
        if (participantId !== user.id) {
          const participantSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.data.user?.id === participantId);

          if (participantSocket) {
            participantSocket.emit('user_stop_typing', {
              chatId,
              userId: user.id
            });
          }
        }
      });
    }
  });

  // Leave group chat
  socket.on('leave_group', async (chatId: string) => {
    try {
      const chat = await dbStorage.getChatById(chatId);
      if (!chat || chat.type !== 'group' || !chat.participants.includes(user.id)) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      dbStorage.removeParticipantFromChat(chatId, user.id);

      // Send system message
      const systemMessage: Message = {
        id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
        senderId: 'system',
        chatId: chat.id,
        content: `${user.displayName} left the group`,
        timestamp: new Date(),
        type: 'system',
        readBy: chat.participants,
        isEdited: false,
        isDeleted: false,
        reactions: {}
      };

      await dbStorage.addMessage(systemMessage);

      // Notify all participants
      chat.participants.forEach(participantId => {
        const participantSocket = Array.from(io.sockets.sockets.values())
          .find(s => s.data.user?.id === participantId);

        if (participantSocket) {
          participantSocket.emit('user_left_group', {
            chatId,
            userId: user.id,
            message: systemMessage
          });
        }
      });

      socket.emit('left_group', { chatId });

    } catch (error) {
      console.error('Leave group error:', error);
      socket.emit('error', { message: 'Failed to leave group' });
    }
  });

  // Update user profile
  socket.on('update_profile', async (data: { displayName?: string; avatar?: string }) => {
    try {
      console.log(`[SOCKET] Updating profile for user: ${user.displayName} (${user.id})`, data);
      console.log(`[SOCKET] Received data:`, JSON.stringify(data, null, 2));

      const patch: { displayName?: string; avatar?: string } = {};
      if (data.displayName !== undefined) patch.displayName = data.displayName;
      if (data.avatar !== undefined) {
        patch.avatar = await resolveAvatarInput(
          data.avatar,
          { userId: user.id, kind: 'user' },
          publicBase
        );
      }

      const updatedUser = await dbStorage.updateUser(user.id, patch);

      if (updatedUser) {
        // Update the user in socket storage
        dbStorage.updateSocketUser(user.id, {
          displayName: updatedUser.displayName,
          avatar: updatedUser.avatar
        });

        // Broadcast the updated user info to all connected clients
        const updatedSocketUser = {
          id: updatedUser.id,
          username: updatedUser.username,
          displayName: updatedUser.displayName,
          avatar: normalizeAvatarUrl(updatedUser.avatar, publicBase) ?? updatedUser.avatar,
          status: updatedUser.status,
          socketId: socket.id
        };

        // Send to all clients including the sender
        io.emit('user_profile_updated', updatedSocketUser);
        io.emit('online_users', normalizeOnlineUsers(dbStorage.getOnlineUsers()));

        console.log(`Profile updated and broadcasted: ${updatedUser.displayName}`);
      }
    } catch (error) {
      console.error('Update profile error:', error);
      socket.emit('error', { message: 'Failed to update profile' });
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${user.displayName} (${user.id})`);

    // Never mark the AI account as offline
    if (user.username === 'pigsail') return;

    dbStorage.removeSocketUser(user.id);
    await dbStorage.updateUserStatus(user.id, 'offline');

    // Broadcast user offline status and updated online users list
    socket.broadcast.emit('user_status_changed', {
      userId: user.id,
      status: 'offline'
    });

    // 稍微延迟广播在线用户列表，确保状态更新完全同步
    setTimeout(() => {
      const remainingOnlineUsers = dbStorage.getOnlineUsers();
      console.log('Broadcasting updated online users list after disconnection:', remainingOnlineUsers.map(u => u.displayName));
      io.emit('online_users', normalizeOnlineUsers(remainingOnlineUsers));
    }, 50);
  });
});

// Clean up typing indicators periodically
setInterval(async () => {
  const now = new Date();
  const allChats = await dbStorage.getChatsByUserId('');

  // Get all unique chat IDs
  const chatIds = new Set<string>();
  allChats.forEach(chat => chatIds.add(chat.id));

  chatIds.forEach(chatId => {
    const typingUsers = dbStorage.getTypingUsers(chatId);
    const updatedTypingUsers = typingUsers.filter(typingUser => {
      const timeDiff = now.getTime() - typingUser.lastTypingTime.getTime();
      return timeDiff < 5000; // Remove typing indicators older than 5 seconds
    });

    if (updatedTypingUsers.length !== typingUsers.length) {
      // Notify about stopped typing if needed
      typingUsers.forEach(async (typingUser) => {
        if (!updatedTypingUsers.find(u => u.userId === typingUser.userId)) {
          // This user stopped typing
          const chat = await dbStorage.getChatById(chatId);
          if (chat) {
            chat.participants.forEach(participantId => {
              if (participantId !== typingUser.userId) {
                const participantSocket = Array.from(io.sockets.sockets.values())
                  .find(s => s.data.user?.id === participantId);

                if (participantSocket) {
                  participantSocket.emit('user_stop_typing', {
                    chatId,
                    userId: typingUser.userId
                  });
                }
              }
            });
          }
        }
      });
    }
  });
}, 3000);

const PORT = process.env.PORT || 5000;

// Keep the pigsail AI account as a virtual always-online user
async function keepPigsailOnline() {
  try {
    const pigsailUser = await dbStorage.getUserByUsername('pigsail');
    if (!pigsailUser) return;

    const publicBase = getPublicServerBase();
    // Add/refresh pigsail in the in-memory online-users map
    dbStorage.addSocketUser({
      id: pigsailUser.id,
      username: pigsailUser.username,
      displayName: pigsailUser.displayName,
      avatar: normalizeAvatarUrl(pigsailUser.avatar, publicBase) ?? pigsailUser.avatar,
      status: 'online',
      socketId: 'pigsail-virtual'  // synthetic socket id — never removed on disconnect
    });

    // Persist online status to Firestore
    await dbStorage.updateUserStatus(pigsailUser.id, 'online');
  } catch (err) {
    console.error('keepPigsailOnline error:', err);
  }
}

async function startServer() {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      console.error('❌ Failed to connect to database');
      process.exit(1);
    }

    // Initialize database storage
    await dbStorage.initialize();
    console.log('✅ Database initialized successfully');

    await warmSystemAvatarUrlsFromFirebase();

    server.listen(PORT, async () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Stats: ${JSON.stringify(dbStorage.getStats())}`);

      await ensurePigsailAvatarSynced(getPublicServerBase());
      // Make pigsail appear online immediately and keep it that way
      await keepPigsailOnline();
      setInterval(keepPigsailOnline, 60_000); // refresh every minute
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;