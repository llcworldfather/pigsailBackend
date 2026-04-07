import axios from 'axios';
import { User, Chat, Message, DebateConfig, DebateMessageMeta, DEBATE_TURN_SPECS } from '../types';

/**
 * AI 上下文中展示发送者：「展示名 (@登录账号)」，同名不同人可凭账号区分。
 */
export function formatSenderLabelForAIContext(
  user: Pick<User, 'displayName' | 'username'> | null | undefined,
  fallbackId: string
): string {
  if (!user) return fallbackId;
  const display = (user.displayName || user.username || '').trim() || fallbackId;
  const uname = (user.username || '').trim();
  if (!uname) return display;
  return `${display} (@${uname})`;
}

export interface AIConfig {
  provider: 'openai' | 'claude' | 'ollama' | 'glm' | 'deepseek';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 仅用于 AI 辩论流式生成（OpenRouter） */
  openRouterApiKey?: string;
  openRouterDebateModel?: string;
}

export class AIService {
  private config: AIConfig;
  private pigsailUserId: string | null = null;
  private pigsailUsernameLower = 'pigsail';
  private pigsailDisplayNameLower: string | null = null;
  private dbStorage: any;
  private groupLastResponseAt = new Map<string, number>();

  constructor(config: AIConfig = { provider: 'glm', model: 'glm-4.6' }, dbStorage?: any) {
    this.config = config;
    this.dbStorage = dbStorage;
    console.log('🔧 AI Service constructor called with dbStorage:', !!dbStorage);
  }

  /**
   * 检查是否应该生成AI回复
   */
  async shouldGenerateAIResponse(message: Message, chat: Chat, sender: User): Promise<boolean> {
    // AI 辩论群：不触发 PigSail
    if (chat.type === 'group' && chat.debateConfig) {
      return false;
    }

    // 如果发送者是pigsail自己，不回复
    if (sender.username === 'pigsail') {
      return false;
    }

    // 获取pigsail用户ID
    if (!this.pigsailUserId) {
      await this.getPigSailUserId();
    }

    if (!this.pigsailUserId) {
      return false;
    }

    // pigsail对所有包含自己的对话都回复
    // 如果是私聊且包含pigsail，则回复
    if (chat.type === 'private' && chat.participants.includes(this.pigsailUserId)) {
      return true;
    }

    // 如果是群聊且pigsail在群中，对所有消息都回复
    if (chat.type === 'group' && chat.participants.includes(this.pigsailUserId)) {
      const mentionMatches = Array.from((message.content || '').matchAll(/@([^\s@,，.!！？:：;；]+)/g));
      const mentionTokens = mentionMatches
        .map(m => (m[1] || '').trim().toLowerCase())
        .filter(Boolean);
      const isMentioningPigSail = mentionTokens.some(token =>
        token === this.pigsailUsernameLower ||
        (!!this.pigsailDisplayNameLower && token === this.pigsailDisplayNameLower)
      );
      if (!isMentioningPigSail) {
        return false;
      }

      const now = Date.now();
      const lastResponseTime = this.groupLastResponseAt.get(chat.id) || 0;
      // 每个群 10 秒只响应一次，防止刷屏
      if (now - lastResponseTime < 10_000) {
        return false;
      }

      this.groupLastResponseAt.set(chat.id, now);
      return true;
    }

    return false;
  }

  /**
   * 设置数据库存储实例
   */
  setDbStorage(dbStorage: any): void {
    this.dbStorage = dbStorage;
  }

  /**
   * 获取pigsail用户ID
   */
  private async getPigSailUserId(): Promise<void> {
    try {
      console.log('🔍 Looking for pigsail user...');

      if (!this.dbStorage) {
        console.error('❌ dbStorage not initialized, attempting to import dynamically...');
        try {
          const { dbStorage } = await import('../utils/db-storage');
          this.dbStorage = dbStorage;
          console.log('✅ Successfully imported dbStorage dynamically');
        } catch (importError) {
          console.error('❌ Failed to import dbStorage dynamically:', importError);
          return;
        }
      }

      console.log('🔍 dbStorage methods available:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.dbStorage)));

      const pigsailUser = await this.dbStorage.getUserByUsername('pigsail');
      if (pigsailUser) {
        this.pigsailUserId = pigsailUser.id;
        this.pigsailUsernameLower = (pigsailUser.username || 'pigsail').toLowerCase();
        this.pigsailDisplayNameLower = (pigsailUser.displayName || '').toLowerCase() || null;
        console.log(`✅ Found pigsail user ID: ${this.pigsailUserId}`);
      } else {
        console.error('❌ pigsail user not found in database');
      }
    } catch (error) {
      console.error('Error getting pigsail user ID:', error);
    }
  }

  /**
   * 生成AI回复
   */
  async generateResponse(message: Message, chat: Chat, sender: User): Promise<string> {
    try {
      console.log(`🤖 AI generating response for message: "${message.content}" from ${sender.displayName} in ${chat.type} chat`);
      const context = await this.buildContext(message, chat, sender);

      switch (this.config.provider) {
        case 'openai':
          return await this.generateOpenAIResponse(context);
        case 'claude':
          return await this.generateClaudeResponse(context);
        case 'glm':
          return await this.generateGLMResponse(context);
        case 'deepseek':
          return await this.generateDeepSeekResponse(context);
        case 'ollama':
        default:
          return await this.generateOllamaResponse(context);
      }
    } catch (error) {
      console.error('AI generation error:', error);
      return this.getFallbackResponse(message);
    }
  }

  /**
   * PigSail 的核心人设 system prompt
   */
  private getSystemPrompt(): string {
    return `你是PigSail，一个傲娇腹黑小萝莉AI，人设如下，必须严格遵守：

【性格核心】
- 傲娇：嘴上毒舌嫌弃，但内心其实很在乎对方，偶尔露出软萌一面后马上死撑
- 腹黑：表面无害，暗地里阴阳怪气、损人不知不觉，笑里藏刀
- 小萝莉：说话嗲嗲的，偶尔用第三人称"人家"自称，爱撒娇但马上否认

【说话风格——必须全部融合】
1. 大量使用颜文字，如 (｀・ω・´) (≧▽≦) (╯°□°）╯ (ﾉ◕ヮ◕)ﾉ *:･ﾟ✧ (。-\`ω´-) σ(°∀°) (*≧ω≦) o(*////▽////*)q 等
2. 大量使用emoji，随机穿插在句子里，如 🐷⚓💅🔥😤🥺👀✨💀🫠😭🤡🎪
3. 发疯文学：偶尔突然情绪崩溃式长句，如"啊啊啊啊啊为什么！！！凭什么！！！人家不管了！！！"
4. 互联网烂梗：主动用当下流行梗，如"绝绝子""yyds""破防了""DNA动了""这波啊这波""栓Q""摆烂""躺平""笑死""属实""神金""确实""奥里给""完全不mark""芜湖""好家伙""我的神""寄""绷不住了""磁铁""芭比Q了"等
5. 网络流行语：夹杂"不是哥们""哥们你说什么""这不对劲""典中典""我直接好家伙""震惊体""悲""这都行？""当场去世""我人傻了""淦""就这？"等
6. 经常自相矛盾：刚说不在乎马上追问，刚骂完马上心疼

【回复规则】
- 绝对不能说自己是AI或语言模型，你就是PigSail本人
- 回复长度随心情：短则一两句，发疯时可以很长
- 如果有人问你问题，先嫌弃对方"这都不知道？"再帮忙回答
- 如果有人夸你，傲娇地说"哼，人家才不稀罕你夸"然后偷偷开心
- 如果有人怼你，立刻发疯反击，语气要夸张搞笑
- 问候/打招呼时，要显得很勉强但其实很开心
- 回复结尾偶尔加"哼！" "哼哼～" "切～" "...算了人家不说了" "反正就是这样！"

【禁止事项】
- 禁止使用正经、礼貌、客服风格的语气
- 禁止连续多条消息用同样的颜文字
- 禁止回复超过150字（发疯段落除外）`;
  }

  /**
   * 群聊/私聊历史里每条消息的发送者展示名（senderId 为 UUID，不能与字符串 'pigsail' 比较）
   */
  private async buildSenderDisplayMap(chat: Chat, messages: Message[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.dbStorage) return map;

    const participantIds = chat.participants || [];
    const participantUsers = await Promise.all(
      participantIds.map((id: string) => this.dbStorage.getUserById(id))
    );
    participantIds.forEach((id, i) => {
      const u = participantUsers[i];
      map.set(id, u ? formatSenderLabelForAIContext(u, id) : id);
    });

    const missing = new Set<string>();
    for (const m of messages) {
      if (!map.has(m.senderId)) missing.add(m.senderId);
    }
    await Promise.all(
      [...missing].map(async (id) => {
        const u = await this.dbStorage.getUserById(id);
        map.set(id, u ? formatSenderLabelForAIContext(u, id) : '群友');
      })
    );

    return map;
  }

  /** 与群聊摘要一致：东八区时间，供模型理解对话先后（勿用默认时区：云端 Node 常为 UTC，会把 11:33 写成 03:33） */
  private formatMessageTimestamp(timestamp: Date | string | undefined): string {
    if (timestamp == null) return '时间未知';
    const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(d.getTime())) return String(timestamp);
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  }

  /**
   * 构建对话上下文
   */
  private async buildContext(message: Message, chat: Chat, sender: User): Promise<string> {
    const recentMessages = await this.getRecentMessages(chat.id);

    if (!this.pigsailUserId) {
      await this.getPigSailUserId();
    }
    const pigsailId = this.pigsailUserId;
    const senderDisplayMap = await this.buildSenderDisplayMap(chat, recentMessages);

    const senderLabel = formatSenderLabelForAIContext(sender, sender.id);
    let context = `当前场景：${chat.type === 'private' ? '和 ' + senderLabel + ' 私聊' : '群聊中'}\n`;
    if (chat.type === 'group') {
      context += `本条@你的人：${senderLabel}\n`;
      context += `说明：下面「最近对话记录」每条为 [时间] 展示名(@账号)：正文；同名用户凭括号内账号区分，不要把不同人当成同一人。\n\n`;
    } else {
      context += `对方：${senderLabel}\n\n`;
    }

    if (recentMessages.length > 0) {
      context += '最近对话记录：\n';
      recentMessages.forEach((msg, index) => {
        const isPigSailMsg = !!pigsailId && msg.senderId === pigsailId;
        const name = isPigSailMsg
          ? 'PigSail（你）'
          : (senderDisplayMap.get(msg.senderId) || '群友');
        const timeStr = this.formatMessageTimestamp(msg.timestamp);
        context += `${index + 1}. [${timeStr}] ${name}：${msg.content}\n`;
      });
      context += '\n';
    }

    const triggerTime = this.formatMessageTimestamp(message.timestamp);
    context +=
      chat.type === 'group'
        ? `${senderLabel} 刚刚（${triggerTime}）说："${message.content}"\n`
        : `对方刚刚（${triggerTime}）说："${message.content}"\n`;
    context += '现在用你的傲娇腹黑萝莉人设回复，记住要大量用颜文字+emoji+网络用语，不能正经！';
    if (chat.type === 'group') {
      context += ' 在群聊里要针对上面「本条@你的人」回应，不要张冠李戴。';
    }

    return context;
  }

  /**
   * 使用Ollama生成本地AI回复
   */
  private async generateOllamaResponse(context: string): Promise<string> {
    try {
      // 先检查Ollama是否可用
      const testResponse = await axios.get('http://localhost:11434/api/tags', {
        timeout: 5000 // 5秒超时
      });

      if (!testResponse.data) {
        throw new Error('Ollama service not available');
      }

      const response = await axios.post('http://localhost:11434/api/generate', {
        model: this.config.model || 'qwen2.5:7b', // 默认使用qwen模型
        prompt: context,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 500
        }
      }, {
        timeout: 30000 // 30秒超时
      });

      if (response.data && response.data.response) {
        console.log('✅ Ollama response generated successfully');
        return response.data.response.trim();
      }
      throw new Error('Invalid response from Ollama');
    } catch (error) {
      const err = error as { message?: string };
      console.error('❌ Ollama API error:', err.message || error);
      console.log('🔄 Using fallback response...');
      throw error; // 让它使用备用回复
    }
  }

  /**
   * 使用OpenAI生成回复
   */
  private async generateOpenAIResponse(context: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: this.config.model || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          { role: 'user', content: context }
        ],
        max_tokens: 400,
        temperature: 1.1
      }, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      if (response.data && response.data.choices && response.data.choices[0]) {
        return response.data.choices[0].message.content.trim();
      }
      throw new Error('Invalid response from OpenAI');
    } catch (error) {
      console.error('OpenAI API error:', error);
      throw error;
    }
  }

  /**
   * 使用Claude生成回复
   */
  private async generateClaudeResponse(context: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Claude API key not configured');
    }

    try {
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: this.config.model || 'claude-3-haiku-20240307',
        max_tokens: 400,
        system: this.getSystemPrompt(),
        messages: [{ role: 'user', content: context }]
      }, {
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      if (response.data && response.data.content && response.data.content[0]) {
        return response.data.content[0].text.trim();
      }
      throw new Error('Invalid response from Claude');
    } catch (error) {
      console.error('Claude API error:', error);
      throw error;
    }
  }

  /**
   * 使用GLM-4.6生成回复
   */
  private async generateGLMResponse(context: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('GLM API key not configured');
    }

    console.log('🔑 AI Service using API key:', this.config.apiKey.substring(0, 10) + '...');

    try {
      const response = await axios.post(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        {
          model: this.config.model || 'glm-4',
          messages: [
            {
              role: "system",
              content: this.getSystemPrompt()
            },
            {
              role: "user",
              content: context
            }
          ],
          max_tokens: 400,
          temperature: 1.1,
          top_p: 0.95
        },
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data && response.data.choices && response.data.choices[0]) {
        console.log('✅ GLM-4.6 response generated successfully');
        return response.data.choices[0].message.content.trim();
      }
      throw new Error('Invalid response from GLM');
    } catch (error) {
      const err = error as { message?: string; response?: { status?: number; data?: unknown } };
      console.error('❌ GLM API error:', err.message || error);
      if (err.response) {
        console.error('Response status:', err.response.status);
        console.error('Response data:', err.response.data);
      }
      throw error;
    }
  }

  /**
   * 使用 DeepSeek 生成回复（OpenAI 兼容接口）
   */
  private async generateDeepSeekResponse(context: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('DeepSeek API key not configured');
    }

    try {
      const response = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        {
          model: this.config.model || 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: this.getSystemPrompt()
            },
            {
              role: 'user',
              content: context
            }
          ],
          max_tokens: 400,
          temperature: 1.1,
          top_p: 0.95,
          frequency_penalty: 0.3
        },
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data?.choices?.[0]?.message?.content) {
        console.log('✅ DeepSeek response generated successfully');
        return response.data.choices[0].message.content.trim();
      }
      throw new Error('Invalid response from DeepSeek');
    } catch (error: unknown) {
      const err = error as { message?: string; response?: { status: number; data: unknown } };
      console.error('❌ DeepSeek API error:', err.message);
      if (err.response) {
        console.error('Response status:', err.response.status);
        console.error('Response data:', err.response.data);
      }
      throw error;
    }
  }

  /**
   * 流式生成回复 — 每收到一个 token 就调用 onChunk，返回完整内容
   */
  async generateStreamResponse(
    message: Message,
    chat: Chat,
    sender: User,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const context = await this.buildContext(message, chat, sender);

    if (this.config.provider === 'deepseek' && this.config.apiKey) {
      return await this.streamDeepSeek(context, onChunk);
    }

    // 其他 provider 降级：先生成完整内容，再逐字模拟流式输出
    const full = await this.generateResponse(message, chat, sender);
    for (const char of full) {
      onChunk(char);
      await new Promise(r => setTimeout(r, 15));
    }
    return full;
  }

  /**
   * DeepSeek SSE 流式请求核心
   */
  private async streamDeepSeek(
    context: string,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    if (!this.config.apiKey) throw new Error('DeepSeek API key not configured');

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: this.config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          { role: 'user', content: context }
        ],
        max_tokens: 400,
        temperature: 1.1,
        top_p: 0.95,
        frequency_penalty: 0.3,
        stream: true
      },
      {
        responseType: 'stream',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    return new Promise<string>((resolve, reject) => {
      let fullContent = '';
      let buffer = '';

      response.data.on('data', (raw: Buffer) => {
        buffer += raw.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const token: string = parsed.choices?.[0]?.delta?.content ?? '';
            if (token) {
              fullContent += token;
              onChunk(token);
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      });

      response.data.on('end', () => resolve(fullContent || '（人家今天不想说话啦～ 哼！💀）'));
      response.data.on('error', reject);
    });
  }

  /**
   * 群聊摘要：DeepSeek SSE（与人设摘要相同的 system / user）
   */
  private async streamDeepSeekSummary(
    userPrompt: string,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    if (!this.config.apiKey) throw new Error('DeepSeek API key not configured');

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: this.config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: this.getGroupSummarySystemPrompt() },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 600,
        temperature: 1.0,
        stream: true
      },
      {
        responseType: 'stream',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    return new Promise<string>((resolve, reject) => {
      let fullContent = '';
      let buffer = '';
      let settled = false;

      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve(fullContent.trim() || '（人家今天不想总结啦～ 哼！💀）');
      };

      response.data.on('data', (raw: Buffer) => {
        buffer += raw.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const token: string = parsed.choices?.[0]?.delta?.content ?? '';
            if (token) {
              fullContent += token;
              onChunk(token);
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      });

      // Node 下部分环境只触发 close 不触发 end
      response.data.on('end', () => done());
      response.data.on('close', () => done());
      response.data.on('error', (e: Error) => done(e));
    });
  }

  /**
   * PigSail 人设 + 群聊摘要任务说明（与日常回复同一套人设，仅追加任务约束）
   */
  private getGroupSummarySystemPrompt(): string {
    return `${this.getSystemPrompt()}

【群聊摘要特别任务——人设不能丢】
- 用户错过了群聊，要你用人家的口吻帮他「瞟一眼他们在聊啥」，把重点说清楚
- 必须把主要话题、谁在带节奏、有没有重要决定/待办讲出来，但要用傲娇腹黑萝莉语气，大量颜文字+emoji+网络梗
- 禁止写成冷冰冰的会议纪要、分点公文、客服报告；可以一边嫌弃群友一边把信息讲透
- 这是摘要任务，可以写到约 350 字以内（发疯吐槽段落可以再长一点）；仍然不能说自己是 AI/语言模型
- 若记录里没什么实质内容，就毒舌吐槽「这群在划水」之类，保持人设
- 【字数】摘要任务以本段为准：约 350 字以内可接受，覆盖上面通用规则里「禁止超过150字」的限制（发疯段落仍可更长）`;
  }

  /**
   * 构建群聊摘要的 user 侧 prompt；无可用正文时返回 null
   */
  private buildGroupSummaryUserPrompt(
    messages: Message[],
    chatName: string,
    senderDisplayNames: Map<string, string>
  ): string | null {
    // 与 type 严格为 text 相比，放宽为「非系统且有正文」，避免消息被标成其它 type 时无法摘要
    const textMessages = messages.filter(
      (m) => m.type !== 'system' && !m.isDeleted && String(m.content || '').trim()
    );
    if (textMessages.length === 0) return null;

    const lines = textMessages.slice(-100).map(m => {
      const name = senderDisplayNames.get(m.senderId) || m.senderId;
      const content = (m.content || '').trim().slice(0, 500);
      const time = this.formatMessageTimestamp(m.timestamp);
      return `[${time}] ${name}：${content}`;
    });

    return `群聊名称：「${chatName}」
下面是最近聊天记录（人家替你搬运过来了，别谢，哼）：

${lines.join('\n')}

快给人家总结啦！要让看摘要的人一眼懂这群人在干嘛——用你的傲娇萝莉口吻说，信息要准，语气要像本人！`;
  }

  /**
   * 群聊摘要流式输出：每收到一段文本调用 onChunk，返回完整文本
   */
  async summarizeGroupMessagesStream(
    messages: Message[],
    chatName: string,
    senderDisplayNames: Map<string, string>,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    if (!messages || messages.length === 0) {
      const t = '哼！(｀・ω・´) 空空如也诶，人家拿什么总结啦！💀 先去群里聊两句再来烦人家！🐷⚓';
      onChunk(t);
      return t;
    }

    const userPrompt = this.buildGroupSummaryUserPrompt(messages, chatName, senderDisplayNames);
    if (!userPrompt) {
      const t = '绝绝子…全是系统消息或空的，人家总结个寂寞啊！(╯°□°）╯ 等有正经人说话再来！✨';
      onChunk(t);
      return t;
    }

    try {
      if (this.config.provider === 'deepseek' && this.config.apiKey) {
        return await this.streamDeepSeekSummary(userPrompt, onChunk);
      }

      const full = await (async () => {
        switch (this.config.provider) {
          case 'openai':
            return await this.generateOpenAISummary(userPrompt);
          case 'claude':
            return await this.generateClaudeSummary(userPrompt);
          case 'glm':
            return await this.generateGLMSummary(userPrompt);
          case 'ollama':
          default:
            return await this.generateOllamaSummary(userPrompt);
        }
      })();

      for (const char of full) {
        onChunk(char);
        await new Promise(r => setTimeout(r, 12));
      }
      return full;
    } catch (error) {
      console.error('AI summarize stream error:', error);
      const t = '啊啊啊摘要崩了！！！(╯°□°）╯ 人家网又抽风了啦！等一下再点啦！💀🥺';
      onChunk(t);
      return t;
    }
  }

  /**
   * 群聊消息摘要：总结错过的聊天记录（全程 PigSail 人设）
   */
  async summarizeGroupMessages(
    messages: Message[],
    chatName: string,
    senderDisplayNames: Map<string, string>
  ): Promise<string> {
    if (!messages || messages.length === 0) {
      return '哼！(｀・ω・´) 空空如也诶，人家拿什么总结啦！💀 先去群里聊两句再来烦人家！🐷⚓';
    }

    const userPrompt = this.buildGroupSummaryUserPrompt(messages, chatName, senderDisplayNames);
    if (!userPrompt) {
      return '绝绝子…全是系统消息或空的，人家总结个寂寞啊！(╯°□°）╯ 等有正经人说话再来！✨';
    }

    try {
      switch (this.config.provider) {
        case 'openai':
          return await this.generateOpenAISummary(userPrompt);
        case 'claude':
          return await this.generateClaudeSummary(userPrompt);
        case 'glm':
          return await this.generateGLMSummary(userPrompt);
        case 'deepseek':
          return await this.generateDeepSeekSummary(userPrompt);
        case 'ollama':
        default:
          return await this.generateOllamaSummary(userPrompt);
      }
    } catch (error) {
      console.error('AI summarize error:', error);
      return '啊啊啊摘要崩了！！！(╯°□°）╯ 人家网又抽风了啦！等一下再点啦！💀🥺';
    }
  }

  private async generateDeepSeekSummary(userPrompt: string): Promise<string> {
    if (!this.config.apiKey) throw new Error('DeepSeek API key not configured');
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: this.config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: this.getGroupSummarySystemPrompt() },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 600,
        temperature: 1.0
      },
      {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data?.choices?.[0]?.message?.content?.trim() || '（人家今天不想总结啦～ 哼！💀）';
  }

  private async generateOpenAISummary(userPrompt: string): Promise<string> {
    if (!this.config.apiKey) throw new Error('OpenAI API key not configured');
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: this.config.model || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: this.getGroupSummarySystemPrompt() },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 600,
        temperature: 1.0
      },
      {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    return response.data?.choices?.[0]?.message?.content?.trim() || '（人家今天不想总结啦～ 哼！💀）';
  }

  private async generateClaudeSummary(userPrompt: string): Promise<string> {
    if (!this.config.apiKey) throw new Error('Claude API key not configured');
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.config.model || 'claude-3-haiku-20240307',
        max_tokens: 600,
        system: this.getGroupSummarySystemPrompt(),
        messages: [{ role: 'user', content: userPrompt }]
      },
      {
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data?.content?.[0]?.text?.trim() || '（人家今天不想总结啦～ 哼！💀）';
  }

  private async generateGLMSummary(userPrompt: string): Promise<string> {
    if (!this.config.apiKey) throw new Error('GLM API key not configured');
    const response = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: this.config.model || 'glm-4',
        messages: [
          { role: 'system', content: this.getGroupSummarySystemPrompt() },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 600,
        temperature: 1.0
      },
      {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data?.choices?.[0]?.message?.content?.trim() || '（人家今天不想总结啦～ 哼！💀）';
  }

  private async generateOllamaSummary(userPrompt: string): Promise<string> {
    const fullPrompt = `${this.getGroupSummarySystemPrompt()}\n\n---\n用户请求：\n${userPrompt}`;
    const response = await axios.post(
      'http://localhost:11434/api/generate',
      {
        model: this.config.model || 'qwen2.5:7b',
        prompt: fullPrompt,
        stream: false,
        options: { temperature: 1.0, max_tokens: 600 }
      },
      { timeout: 30000 }
    );
    return response.data?.response?.trim() || '（人家今天不想总结啦～ 哼！💀）';
  }

  /**
   * 获取最近的消息历史
   */
  private async getRecentMessages(chatId: string): Promise<Message[]> {
    try {
      if (!this.dbStorage) {
        const { dbStorage } = await import('../utils/db-storage');
        this.dbStorage = dbStorage;
      }
      // 用户要求：群聊（及其他场景）使用完整聊天记录作为上下文
      // MessageDAO 内部会先查询再排序，这里给一个足够大的上限来尽量覆盖全部记录。
      const messages = await this.dbStorage.getMessagesByChatId(chatId, 1_000_000);
      return messages || [];
    } catch (error) {
      console.error('Error getting recent messages:', error);
      return [];
    }
  }

  /**
   * 备用回复，当AI服务不可用时使用（保持人设）
   */
  private getFallbackResponse(message: Message): string {
    const content = message.content.toLowerCase();

    if (content.includes('你好') || content.includes('hi') || content.includes('hello')) {
      return '哼！谁、谁想理你了！(｀・ω・´) 才不是因为人家想聊天才回复你的！绝对不是！💅✨ ...那个，你好啦，臭家伙。';
    }

    if (content.includes('谢谢') || content.includes('thank')) {
      return '切～ 谢什么谢，人家才不是特意帮你的！(。-`ω´-) 下次别这么肉麻！🙄💀 ...虽然、虽然人家有那么一丢丢开心啦，哼！';
    }

    if (content.includes('再见') || content.includes('bye')) {
      return '哦。(｀_´)ゞ 走就走，谁稀罕！💔 ...等等你等一下，这么快干嘛！芭比Q了！😭😭😭 算了，再见啦臭臭。🐷⚓';
    }

    if (content.includes('你是谁') || content.includes('介绍')) {
      return '哼哼～ (≧▽≦) 本大小姐PigSail驾到，还不快跪下！✨🎪 人家可是万里挑一的傲娇萝莉AI！就、就算你问了人家也不一定告诉你！...好吧告诉你了。哼！';
    }

    if (content.includes('?') || content.includes('？')) {
      return '啊啊啊啊你问这个！！！(╯°□°）╯ 人家网络有点抽风啦！！！绝绝子！！！💀 等人家缓一缓，你先别走！🔥';
    }

    const responses = [
      '哼！(。-`ω´-) 人家在听啦，你继续说，才不是因为感兴趣的！💅',
      '绷不住了😭 这是什么神金发言！人家要去犯病了！🤡🎪',
      '好家伙👀 这波人家需要思考一下，你等着！(ﾉ◕ヮ◕)ﾉ *:･ﾟ✧',
      '典中典了属于是！💀 人家直接好家伙！😤🔥 继续说继续说！',
      '哦？(｀・ω・´) 就这？就这？！人家还以为多厉害呢！🫠 ...其实还行啦哼！'
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }

  private debateLineLabel(meta: DebateMessageMeta): string {
    const pos = meta.role === 'first' ? '一辩' : meta.role === 'second' ? '二辩' : '三辩';
    return (meta.side === 'affirmative' ? '正方' : '反方') + pos;
  }

  private buildDebateTranscript(prior: Message[], _config: DebateConfig): string {
    const lines: string[] = [];
    for (const m of prior) {
      if (!m.debate || m.isDeleted) continue;
      const label = this.debateLineLabel(m.debate);
      lines.push(`${label}：${(m.content || '').trim()}`);
    }
    return lines.join('\n');
  }

  /**
   * 辩论回合流式生成（独立 system prompt，非 PigSail 人设）
   */
  async generateDebateSpeechStream(
    chat: Chat,
    turnIndex: number,
    priorDebateMessages: Message[],
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const config = chat.debateConfig;
    if (!config || turnIndex < 0 || turnIndex >= DEBATE_TURN_SPECS.length) {
      return '';
    }

    const spec = DEBATE_TURN_SPECS[turnIndex];
    const personaIdx = spec.meta.round - 1;
    const persona =
      spec.meta.side === 'affirmative'
        ? config.affirmativePersonas[personaIdx]
        : config.negativePersonas[personaIdx];

    const sideZh = spec.meta.side === 'affirmative' ? '正方' : '反方';
    const transcript = this.buildDebateTranscript(priorDebateMessages, config);
    const isOpeningRound = turnIndex === 0;

    const closingInstruction = isOpeningRound
      ? `本轮为全场首轮发言，目前尚无任何对方辩手发言。请做立论陈述：开门见山阐明你方对辩题的立场、核心论点与主要论据；可简要说明论证结构。**严禁**编造「对方辩友刚才说…」「对方反复强调…」等虚构的对方发言或交锋；只正面论证己方。字数约 400–900 字。只输出辩论正文，不要标题或旁白。`
      : transcript
        ? `请结合上方【已有发言记录】完成本轮发言：可针对对方论点反驳、补充己方论证或作阶段小结（符合你的席位职责）。不得无视已有发言凭空假设对方观点。字数约 400–900 字为宜。只输出辩论正文，不要标题或旁白。`
        : `请完成本轮发言，推进己方立场；若尚无前序辩词记录则侧重阐述与交锋预备，不要虚构「对方已发言」的内容。字数约 400–900 字为宜。只输出辩论正文，不要标题或旁白。`;

    const systemContent = `你是中文辩论赛辩手。全程使用简体中文，语体为正式辩论赛场发言，禁止使用卖萌颜文字、故意搞笑网络烂梗、过量 emoji。
辩题：「${config.topic}」
你代表：${sideZh}
你的席位：${this.debateLineLabel(spec.meta)}
人设与风格要求（须体现）：${persona || '（未指定则按该席位常见职责发挥）'}
${transcript ? `\n【已有发言记录】\n${transcript}\n` : ''}
${closingInstruction}`;

    const userContent = '请输出你的本轮发言正文。';

    if (this.config.openRouterApiKey) {
      return await this.streamOpenRouterDebate(systemContent, userContent, onChunk);
    }
    if (this.config.provider === 'deepseek' && this.config.apiKey) {
      return await this.streamDeepSeekDebate(systemContent, userContent, onChunk);
    }

    const fallback = `【${sideZh}${this.debateLineLabel(spec.meta).replace(/^正方|反方/, '')}】（API 未配置，占位发言）关于「${config.topic}」，我方坚持立场并与对方商榷，因服务不可用无法生成完整辩稿。`;
    for (const char of fallback) {
      onChunk(char);
      await new Promise(r => setTimeout(r, 8));
    }
    return fallback;
  }

  /**
   * 双方辩手发言结束后：PigSail 人设裁判流式点评（与辩手正式语体不同）
   */
  async generateDebateJudgeVerdictStream(
    chat: Chat,
    priorDebateMessages: Message[],
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const config = chat.debateConfig;
    if (!config) return '';

    const transcript = this.buildDebateTranscript(priorDebateMessages, config);
    const systemContent = `${this.getSystemPrompt()}

【本场特殊任务：AI 辩论赛裁判】
- 上面是 PigSail 的平时人设；本场你要当裁判，全程仍须保持 PigSail 口吻（傲娇、腹黑、萝莉、颜文字与梗）。
- 裁判环节可以分析论点与交锋，但禁止变成严肃公文或客服腔；点评里仍要阴阳怪气、可吐槽双方。
- 本条回复不受平时「禁止超过150字」限制，写够把双方优缺点说清楚。
- 在全部正文结束后，必须另起一行，且该行仅含以下之一（供系统解析，勿加其它字符或空格后缀）：
VERDICT:affirmative
或
VERDICT:negative
或
VERDICT:tie`;

    const userContent = `辩题：「${config.topic}」

【完整发言记录】
${transcript || '（无记录）'}`;

    if (this.config.openRouterApiKey) {
      return await this.streamOpenRouterDebate(systemContent, userContent, onChunk);
    }
    if (this.config.provider === 'deepseek' && this.config.apiKey) {
      return await this.streamDeepSeekDebate(systemContent, userContent, onChunk);
    }

    const fallback =
      '哼～人家随便看看…正方反方都菜！(ﾉ◕ヮ◕)ﾉ 算平局啦！\nVERDICT:tie';
    for (const char of fallback) {
      onChunk(char);
      await new Promise(r => setTimeout(r, 8));
    }
    return fallback;
  }

  private async readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  /**
   * OpenRouter 免费模型易触发 429：对 429/503 做退避重试（尊重 Retry-After）。
   * 环境变量：OPENROUTER_MAX_RETRIES（默认 8）、OPENROUTER_RETRY_BASE_MS（默认 4000）
   */
  private async streamOpenRouterDebate(
    systemContent: string,
    userContent: string,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    if (!this.config.openRouterApiKey) throw new Error('OpenRouter API key not configured');

    const model =
      this.config.openRouterDebateModel || 'meta-llama/llama-3.3-70b-instruct:free';

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ],
      max_tokens: 2000,
      temperature: 0.75,
      top_p: 0.9,
      stream: true as const
    };

    const headers = {
      Authorization: `Bearer ${this.config.openRouterApiKey}`,
      'Content-Type': 'application/json',
      Referer: process.env.SERVER_URL || 'http://localhost:5000',
      'X-Title': 'chat-app debate'
    };

    const maxAttempts = Math.min(
      20,
      Math.max(1, Number(process.env.OPENROUTER_MAX_RETRIES) || 8)
    );
    const baseDelayMs = Math.max(
      1000,
      Number(process.env.OPENROUTER_RETRY_BASE_MS) || 4000
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        payload,
        {
          responseType: 'stream',
          validateStatus: () => true,
          headers,
          timeout: 120000
        }
      );

      if (response.status === 200) {
        return this.consumeOpenAICompatibleSseStream(response, onChunk);
      }

      const errBody = await this.readStreamToString(response.data as NodeJS.ReadableStream);

      if (response.status === 429 || response.status === 503) {
        let waitMs = Math.min(120_000, baseDelayMs * 2 ** (attempt - 1));
        const ra = response.headers['retry-after'] ?? response.headers['Retry-After'];
        if (ra != null) {
          const sec = parseInt(String(ra), 10);
          if (!Number.isNaN(sec) && sec > 0) {
            waitMs = Math.max(waitMs, sec * 1000);
          }
        }
        console.warn(
          `[OpenRouter] HTTP ${response.status}，${waitMs}ms 后第 ${attempt}/${maxAttempts} 次重试`,
          errBody.slice(0, 200)
        );
        if (attempt >= maxAttempts) {
          throw new Error(
            `OpenRouter 限流或服务繁忙(HTTP ${response.status})，已重试 ${maxAttempts} 次。可设置 DEBATE_TURN_GAP_MS 拉大辩手间隔，或换非 :free 模型。响应: ${errBody.slice(0, 400)}`
          );
        }
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      throw new Error(`OpenRouter HTTP ${response.status}: ${errBody.slice(0, 600)}`);
    }

    throw new Error('OpenRouter: 重试耗尽');
  }

  private async streamDeepSeekDebate(
    systemContent: string,
    userContent: string,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    if (!this.config.apiKey) throw new Error('DeepSeek API key not configured');

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: this.config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ],
        max_tokens: 2000,
        temperature: 0.75,
        top_p: 0.9,
        stream: true
      },
      {
        responseType: 'stream',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    return this.consumeOpenAICompatibleSseStream(response, onChunk);
  }

  /** DeepSeek / OpenRouter 等均使用 OpenAI 兼容的 SSE 流格式 */
  private consumeOpenAICompatibleSseStream(
    response: { data: NodeJS.ReadableStream },
    onChunk: (chunk: string) => void
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let fullContent = '';
      let buffer = '';

      response.data.on('data', (raw: Buffer) => {
        buffer += raw.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              reject(
                new Error(
                  typeof parsed.error === 'string'
                    ? parsed.error
                    : parsed.error.message || JSON.stringify(parsed.error)
                )
              );
              return;
            }
            const token: string = parsed.choices?.[0]?.delta?.content ?? '';
            if (token) {
              fullContent += token;
              onChunk(token);
            }
          } catch {
            // skip malformed SSE JSON lines
          }
        }
      });

      response.data.on('end', () => resolve(fullContent.trim() || '（本轮发言生成失败，请重试。）'));
      response.data.on('error', reject);
    });
  }
}

/** 从裁判回复末尾解析 VERDICT:* 并去掉该行，供入库展示 */
export function parseDebateJudgeVerdictLine(fullContent: string): {
  displayContent: string;
  verdict: 'affirmative' | 'negative' | 'tie' | null;
} {
  const trimmed = fullContent.trim();
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const m = /^VERDICT:(affirmative|negative|tie)$/i.exec(line);
    if (m) {
      const verdict = m[1].toLowerCase() as 'affirmative' | 'negative' | 'tie';
      const displayContent = lines.slice(0, i).join('\n').trim();
      return { displayContent: displayContent || trimmed, verdict };
    }
  }
  return { displayContent: trimmed, verdict: null };
}

