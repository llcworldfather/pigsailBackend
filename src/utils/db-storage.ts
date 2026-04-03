import { UserDAO, ChatDAO, MessageDAO, FriendRequestDAO } from '../dao';
import { User, Message, Chat, SocketUser, TypingUser, FriendRequest, DebateConfig, DebateState } from '../types';

class DatabaseStorage {
  // Online users - still keep in memory for socket management
  private socketUsers = new Map<string, SocketUser>();
  private typingUsers = new Map<string, TypingUser[]>();

  // User methods - delegated to UserDAO
  async createUser(userData: { username: string; displayName: string; email?: string; passwordHash: string; avatar?: string }): Promise<User> {
    const user = {
      id: this.generateId(),
      email: userData.email || `${userData.username}@example.com`, // 如果没有提供email，使用默认值
      ...userData
    };

    return await UserDAO.create(user);
  }

  async getUserById(id: string): Promise<User | undefined> {
    const user = await UserDAO.findById(id);
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const user = await UserDAO.findByUsername(username);
    return user || undefined;
  }

  async getAllUsers(): Promise<User[]> {
    return await UserDAO.findAll();
  }

  async updateUserStatus(id: string, status: User['status']): Promise<void> {
    await UserDAO.updateStatus(id, status);
  }

  async updateLastSeen(id: string): Promise<void> {
    await UserDAO.updateLastSeen(id);
  }

  async updateUser(id: string, updates: {
    displayName?: string;
    avatar?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<User | null> {
    return await UserDAO.updateProfile(id, {
      displayName: updates.displayName,
      avatar: updates.avatar,
      email: updates.email,
      passwordHash: updates.passwordHash
    });
  }

  // Chat methods - delegated to ChatDAO
  async createChat(chatData: Omit<Chat, 'id' | 'createdAt' | 'unreadCounts' | 'lastMessage'>): Promise<Chat> {
    const chat = {
      ...chatData,
      id: this.generateId()
    };

    return await ChatDAO.create(chat);
  }

  async getChatById(id: string): Promise<Chat | undefined> {
    const chat = await ChatDAO.findById(id);
    return chat || undefined;
  }

  async getChatsByUserId(userId: string): Promise<Chat[]> {
    return await ChatDAO.findByUserId(userId);
  }

  async getPrivateChat(user1Id: string, user2Id: string): Promise<Chat | undefined> {
    const chat = await ChatDAO.findPrivateChat(user1Id, user2Id);
    return chat || undefined;
  }

  async updateChatLastMessage(chatId: string, message: Message): Promise<void> {
    await ChatDAO.updateLastMessage(chatId, message.id);
  }

  async markMessagesAsRead(chatId: string, userId: string): Promise<void> {
    await ChatDAO.markMessagesAsRead(chatId, userId);
  }

  async addParticipantToChat(chatId: string, userId: string): Promise<void> {
    await ChatDAO.addParticipant(chatId, userId);
  }

  async removeParticipantFromChat(chatId: string, userId: string): Promise<void> {
    await ChatDAO.removeParticipant(chatId, userId);
  }

  async updateGroupChatProfile(
    chatId: string,
    updates: { name?: string; avatar?: string }
  ): Promise<Chat | null> {
    return await ChatDAO.updateGroupProfile(chatId, updates);
  }

  async updateDebateState(chatId: string, debateState: DebateState, debateConfig?: DebateConfig): Promise<boolean> {
    return await ChatDAO.updateDebateState(chatId, debateState, debateConfig);
  }

  // Message methods - delegated to MessageDAO
  async addMessage(message: Message): Promise<void> {
    await MessageDAO.create(message);
  }

  async getMessagesByChatId(chatId: string, limit = 50, aroundMessageId?: string): Promise<Message[]> {
    if (aroundMessageId) {
      return await MessageDAO.findByChatIdAroundMessage(chatId, aroundMessageId, limit);
    }
    return await MessageDAO.findByChatId(chatId, limit);
  }

  async getMessagesBeforeMessage(
    chatId: string,
    beforeMessageId: string,
    limit = 30
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    return await MessageDAO.findByChatIdBeforeMessage(chatId, beforeMessageId, limit);
  }

  /** 以某条消息为窗口末尾，向前取最多 limit 条（时间正序） */
  async getMessagesEndingAtMessage(chatId: string, anchorMessageId: string, limit = 50): Promise<Message[]> {
    return await MessageDAO.findByChatIdEndingAtMessage(chatId, anchorMessageId, limit);
  }

  /** 获取最近 N 条消息用于 AI 摘要 */
  async getLastMessagesForSummary(chatId: string, limit = 100): Promise<Message[]> {
    return await MessageDAO.getLastMessages(chatId, limit);
  }

  async getMessageById(messageId: string): Promise<Message | undefined> {
    const message = await MessageDAO.findById(messageId);
    return message || undefined;
  }

  async updateMessage(messageId: string, content: string): Promise<boolean> {
    const updated = await MessageDAO.update(messageId, content, 'temp-sender-id'); // This needs proper sender ID handling
    return updated !== null;
  }

  async deleteMessage(messageId: string, userId: string): Promise<boolean> {
    return await MessageDAO.delete(messageId, userId);
  }

  async searchMessages(chatId: string, query: string): Promise<Message[]> {
    return await MessageDAO.searchMessages(chatId, query);
  }

  /** 全局搜索聊天记录：在所有当前用户参与的会话中搜索消息 */
  async searchMessagesGlobal(
    userId: string,
    query: string,
    limitPerChat: number = 15,
    maxChats: number = 20
  ): Promise<Array<{ chatId: string; chatName: string; messages: Message[] }>> {
    const chats = await this.getChatsByUserId(userId);
    const results: Array<{ chatId: string; chatName: string; messages: Message[] }> = [];

    const searchPromises = chats.map(async (chat) => {
      const msgs = await MessageDAO.searchMessages(chat.id, query, limitPerChat);
      if (msgs.length === 0) return null;

      let chatName: string;
      if (chat.type === 'group') {
        chatName = chat.name || '群聊';
      } else {
        const otherId = chat.participants.find((id) => id !== userId);
        if (otherId) {
          const other = await this.getUserById(otherId);
          chatName = other?.displayName || other?.username || `用户 ${otherId.slice(0, 6)}`;
        } else {
          chatName = chat.name || '私聊';
        }
      }
      return { chatId: chat.id, chatName, messages: msgs };
    });

    const settled = await Promise.all(searchPromises);
    for (const item of settled) {
      if (item && results.length < maxChats) results.push(item);
    }
    return results;
  }

  async clearMessagesByChatId(chatId: string): Promise<number> {
    return await MessageDAO.deleteByChatId(chatId);
  }

  async toggleMessageReaction(messageId: string, emoji: string, userId: string): Promise<Message | null> {
    return await MessageDAO.toggleReaction(messageId, emoji, userId);
  }

  async clearChatLastMessage(chatId: string): Promise<boolean> {
    return await ChatDAO.clearLastMessage(chatId);
  }

  // Friend request methods - delegated to FriendRequestDAO
  async createFriendRequest(senderId: string, recipientId: string, message: string): Promise<FriendRequest> {
    return await FriendRequestDAO.create({
      id: this.generateId(),
      senderId,
      recipientId,
      message
    });
  }

  async getPendingFriendRequestBetween(userAId: string, userBId: string): Promise<FriendRequest | null> {
    return await FriendRequestDAO.findPendingBetween(userAId, userBId);
  }

  async getFriendRequestById(id: string): Promise<FriendRequest | null> {
    return await FriendRequestDAO.findById(id);
  }

  async getPendingReceivedFriendRequests(userId: string): Promise<FriendRequest[]> {
    return await FriendRequestDAO.findPendingReceivedByUser(userId);
  }

  async getSentFriendRequests(userId: string): Promise<FriendRequest[]> {
    return await FriendRequestDAO.findBySender(userId);
  }

  async updateFriendRequestStatus(
    requestId: string,
    status: 'accepted' | 'rejected' | 'blocked'
  ): Promise<FriendRequest | null> {
    return await FriendRequestDAO.updateStatus(requestId, status);
  }

  async blockUser(blockerId: string, blockedId: string): Promise<void> {
    await FriendRequestDAO.blockUser(blockerId, blockedId);
  }

  async isUserBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    return await FriendRequestDAO.isBlocked(blockerId, blockedId);
  }

  async deleteChat(chatId: string): Promise<boolean> {
    return await ChatDAO.deleteChat(chatId);
  }

  // Socket user methods - kept in memory
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

  updateSocketUser(id: string, updates: Partial<SocketUser>): void {
    const existingUser = this.socketUsers.get(id);
    if (existingUser) {
      this.socketUsers.set(id, { ...existingUser, ...updates });
    }
  }

  getOnlineUsers(): SocketUser[] {
    const onlineUsers = Array.from(this.socketUsers.values());

    // Ensure socket users have latest info from database
    onlineUsers.forEach(async socketUser => {
      const dbUser = await this.getUserById(socketUser.id);
      if (dbUser) {
        socketUser.username = dbUser.username;
        socketUser.displayName = dbUser.displayName;
        socketUser.avatar = dbUser.avatar;
        socketUser.status = 'online';
      }
    });

    return onlineUsers;
  }

  // Typing methods - kept in memory
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

  getStats() {
    return {
      users: 0, // Will need async call to get actual count
      chats: 0, // Will need async call to get actual count
      messages: 0, // Will need async call to get actual count
      onlineUsers: this.socketUsers.size
    };
  }

  // Serialize chat for Socket.IO transmission
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

  // Initialize database connection
  async initialize(): Promise<void> {
    // Test database connection
    // This will be called during server startup
  }
}

export const dbStorage = new DatabaseStorage();