import { User, Message, Chat, SocketUser, TypingUser } from '../types';

class DataStorage {
  private users = new Map<string, User>();
  private messages = new Map<string, Message[]>();
  private chats = new Map<string, Chat>();
  private socketUsers = new Map<string, SocketUser>();
  private typingUsers = new Map<string, TypingUser[]>();

  // User methods
  createUser(userData: Omit<User, 'id' | 'joinedAt' | 'lastSeen' | 'status'>): User {
    const user: User = {
      id: this.generateId(),
      ...userData,
      status: 'offline',
      joinedAt: new Date(),
      lastSeen: new Date()
    };
    this.users.set(user.id, user);
    return user;
  }

  getUserById(id: string): User | undefined {
    return this.users.get(id);
  }

  getUserByUsername(username: string): User | undefined {
    return Array.from(this.users.values()).find(user => user.username === username);
  }

  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  updateUserStatus(id: string, status: User['status']): void {
    const user = this.users.get(id);
    if (user) {
      user.status = status;
      user.lastSeen = new Date();
    }
  }

  updateLastSeen(id: string): void {
    const user = this.users.get(id);
    if (user) {
      user.lastSeen = new Date();
    }
  }

  // Chat methods
  createChat(chatData: Omit<Chat, 'id' | 'createdAt' | 'unreadCounts'>): Chat {
    const chat: Chat = {
      id: this.generateId(),
      ...chatData,
      createdAt: new Date(),
      unreadCounts: new Map()
    };

    // Initialize unread counts for all participants
    chat.participants.forEach(participantId => {
      chat.unreadCounts.set(participantId, 0);
    });

    this.chats.set(chat.id, chat);
    return chat;
  }

  getChatById(id: string): Chat | undefined {
    return this.chats.get(id);
  }

  getChatsByUserId(userId: string): Chat[] {
    return Array.from(this.chats.values()).filter(chat =>
      chat.participants.includes(userId)
    );
  }

  getPrivateChat(user1Id: string, user2Id: string): Chat | undefined {
    return Array.from(this.chats.values()).find(chat =>
      chat.type === 'private' &&
      chat.participants.includes(user1Id) &&
      chat.participants.includes(user2Id) &&
      chat.participants.length === 2
    );
  }

  updateChatLastMessage(chatId: string, message: Message): void {
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.lastMessage = message;

      // Increment unread count for all participants except sender
      chat.participants.forEach(participantId => {
        if (participantId !== message.senderId) {
          const currentCount = chat.unreadCounts.get(participantId) || 0;
          chat.unreadCounts.set(participantId, currentCount + 1);
        }
      });
    }
  }

  markMessagesAsRead(chatId: string, userId: string): void {
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.unreadCounts.set(userId, 0);

      // Mark all messages in this chat as read by this user
      const messages = this.messages.get(chatId) || [];
      messages.forEach(message => {
        if (!message.readBy.includes(userId)) {
          message.readBy.push(userId);
        }
      });
    }
  }

  addParticipantToChat(chatId: string, userId: string): void {
    const chat = this.chats.get(chatId);
    if (chat && !chat.participants.includes(userId)) {
      chat.participants.push(userId);
      chat.unreadCounts.set(userId, 0);
    }
  }

  removeParticipantFromChat(chatId: string, userId: string): void {
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.participants = chat.participants.filter(id => id !== userId);
      chat.unreadCounts.delete(userId);
    }
  }

  // Message methods
  addMessage(message: Message): void {
    const chatMessages = this.messages.get(message.chatId) || [];
    chatMessages.push(message);
    this.messages.set(message.chatId, chatMessages);
    this.updateChatLastMessage(message.chatId, message);
  }

  getMessagesByChatId(chatId: string, limit = 50): Message[] {
    const messages = this.messages.get(chatId) || [];
    return messages.slice(-limit).sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  updateMessage(messageId: string, content: string): boolean {
    for (const [chatId, messages] of this.messages.entries()) {
      const message = messages.find(m => m.id === messageId);
      if (message && message.senderId === messages[messages.length - 1]?.senderId) {
        message.content = content;
        message.isEdited = true;
        message.editedAt = new Date();
        return true;
      }
    }
    return false;
  }

  // Socket user methods
  addSocketUser(socketUser: SocketUser): void {
    this.socketUsers.set(socketUser.id, socketUser);
  }

  getSocketUser(id: string): SocketUser | undefined {
    return this.socketUsers.get(id);
  }

  getSocketUserBySocketId(socketId: string): SocketUser | undefined {
    return Array.from(this.socketUsers.values()).find(user => user.socketId === socketId);
  }

  removeSocketUser(id: string): void {
    this.socketUsers.delete(id);
  }

  getOnlineUsers(): SocketUser[] {
    const onlineUsers = Array.from(this.socketUsers.values());

    // 确保在线用户的用户状态也是最新的
    onlineUsers.forEach(socketUser => {
      const user = this.users.get(socketUser.id);
      if (user) {
        // 同步用户信息到socketUser，确保数据一致性
        socketUser.username = user.username;
        socketUser.displayName = user.displayName;
        socketUser.avatar = user.avatar;
        socketUser.status = 'online'; // Socket用户必须是在线的
      }
    });

    return onlineUsers;
  }

  // Typing methods
  setTypingUser(chatId: string, typingUser: TypingUser): void {
    const chatTyping = this.typingUsers.get(chatId) || [];
    const existingIndex = chatTyping.findIndex(u => u.userId === typingUser.userId);

    if (existingIndex >= 0) {
      chatTyping[existingIndex] = typingUser;
    } else {
      chatTyping.push(typingUser);
    }

    this.typingUsers.set(chatId, chatTyping);
  }

  removeTypingUser(chatId: string, userId: string): void {
    const chatTyping = this.typingUsers.get(chatId) || [];
    const filtered = chatTyping.filter(u => u.userId !== userId);
    this.typingUsers.set(chatId, filtered);
  }

  getTypingUsers(chatId: string): TypingUser[] {
    return this.typingUsers.get(chatId) || [];
  }

  // Utility methods
  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  // Debug methods
  getStats() {
    return {
      users: this.users.size,
      chats: this.chats.size,
      messages: Array.from(this.messages.values()).reduce((total, messages) => total + messages.length, 0),
      onlineUsers: this.socketUsers.size
    };
  }

  // Serialize chat for Socket.IO transmission (converts Map to Object)
  serializeChat(chat: Chat): any {
    return {
      ...chat,
      unreadCounts: Object.fromEntries(chat.unreadCounts)
    };
  }

  // Serialize multiple chats
  serializeChats(chats: Chat[]): any[] {
    return chats.map(chat => this.serializeChat(chat));
  }
}

export const dataStorage = new DataStorage();