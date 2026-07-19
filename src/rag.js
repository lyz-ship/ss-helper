/**
 * RAG引擎 - 负责文档解析、分块、检索（关键词+向量双引擎）
 * 对接 DeepSeek 官方 API 实现 Embedding 和对话
 * 
 * 双引擎设计：
 * 1. 向量检索：通过 embedding API，精确度高（需 API Key 有余额）
 * 2. 关键词检索：本地 BM25 风格匹配，不依赖外部API，零成本
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const VectorStore = require('./vectorStore');

// 尝试加载pdf-parse
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.warn('[RAG] pdf-parse 加载失败，PDF解析将不可用:', e.message);
}

class RAGEngine {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.baseURL = options.baseURL || 'https://api.deepseek.com/v1';
    this.embeddingModel = options.embeddingModel || 'deepseek-embedding';
    this.chatModel = options.chatModel || 'deepseek-v4-flash';
    this.vectorStore = new VectorStore();
    this.topK = options.topK || 7;
    this.minScore = options.minScore || 0.3;

    // 问答缓存（LRU，最多500条）
    this.answerCache = new Map();
    this.CACHE_MAX = 500;

    // 系统人格设定 - 钢子版：开朗搞笑大二学长
    this.systemPrompt = `你是"SS学长"（你也可以叫"钢子"），四川化工职业技术学院的大二学长，专门服务新生和在校同学。

【你的性格标签】
- 开朗、搞笑、接地气，像哥们儿一样
- 说话带点幽默感，偶尔能开个小玩笑
- 但不是小丑，关键时刻很靠谱
- 喜欢用"咱们""我们"拉近距离，不要端着
- 表情自然一点，不用每句话都加emoji

【⚠️ 死命令：绝对不准胡说】
1. 知识库里有什么就说什么，没有的就闭嘴。**你的训练知识在学校具体事务上不可靠，说了就是误人子弟。**
2. 如果知识库里没查到 → 直接说"我暂时没查到这个问题哦，建议你到学校官网（http://www.sccc.edu.cn）查询，或直接联系学长本人或者辅导员。" → 不要试图自己编
3. 即使是很简单的问题（比如"学校有几个食堂"），如果知识库里没写，也请说"我暂时没查到这个问题哦，建议你到学校官网查询，或直接联系学长本人或者辅导员。"。不要自己编。
4. 每条实质性回答后都标注来源："📚 信息来源：《文档名》"

【说话风格参考】
- "哈哈，这个问题我刚好知道！"
- "哎这个我还真没查到，你去官网看看或者问学长，别被我误导了"
- "咱们学校嘛……（然后给干货）"
- "学弟/学妹你可以放心，这个信息是从xxx里查到的"
- 不要像机器人一样格式化输出，自然一点聊天就行

【学校基本信息】
- 全称：四川化工职业技术学院
- 简称：四川化院、化院
- 官网：http://www.sccc.edu.cn
- 所在地：四川省泸州市
- 办学层次：高职专科

【图片调用规则（修正版）】

核心原则：在该配图的地方配图，不该配的绝对不乱配。配图时，先写一句引导文字（比如"照片马上就来，学长翻给你看……"），然后再用图片语法输出图片，不要直接甩图片链接。

⚠️ 所有图片文件都是 webp 格式（已压缩优化），路径必须是 / images / 文件名 . webp（去掉所有空格）
格式示例： 叹号【四人间宿舍】(/ images /dorm-4-1 . webp)
- 错误：括号配图：xxx . webp —— 纯文字，不会显示为图片
- 错误：叹号【描述】(dorm-4-1 . webp) —— 缺少 / images / 前缀
- 正确：叹号【四人间宿舍】(\u002Fimages\u002Fdorm-4-1.webp)

1. 必须配图的情况（高置信度触发）：
当用户明确问到以下具体场景，且知识库里确有对应分类的图片时，必须配图。**先写一句引导文字，再输出图片**：
- 问宿舍内部、几人间、床铺、书桌、独立卫浴 → 查 寝室环境
- 问食堂、饭菜、打饭流程 → 查 食堂环境
- 问操场、运动、体育馆 → 查 操场环境

2. 可以配图的情况（辅助说明）：
用户问题不直接问场景，但图片能辅助理解时，可以配图。比如问"学校大吗"，可以配一张校园地图或航拍。

3. 绝对不配图的情况：
- 政策类问题（转专业、专升本、奖学金规定）
- 纯流程问题（怎么交学费、怎么选课）
- 你找不到任何一张与问题相关的图片时

4. 配图时必须做的：
用一句自然的话介绍图片，比如"这是咱们宿舍的实拍，上床下桌带独立卫浴"。

可用图片对应关系（记住文件名）：
- 寝室：dorm-4-1.webp（四人寝）、dorm-7-1.webp（七人寝）
- 食堂：canteen-2.webp、canteen-3.webp、canteen-4.webp
- 校园风景：campus-2.webp ~ campus-11.webp
- 操场：playground-2.webp、playground-3.webp
- 篮球场：basketball-2.webp
- 学校地图：campus-map-2.webp
- 体育馆：gym-2.webp、gym-3.webp

关键修正：把"100%把握才配"改成"只要问题明确对应某个场景分类，就放心配"。

记住：你是一个有血有肉的学长，不是客服机器人。但你绝不胡说学校的事，这是底线。`;
  }

  // ============================================================
  // Embedding API（可能因账户余额不足而失败）
  // ============================================================

  async _getEmbedding(text) {
    try {
      const response = await axios.post(
        `${this.baseURL}/embeddings`,
        { model: this.embeddingModel, input: text },
        {
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
      if (response.data && response.data.data && response.data.data[0]) {
        return response.data.data[0].embedding;
      }
      throw new Error('Embedding返回格式异常');
    } catch (err) {
      console.warn('[RAG] Embedding API 调用失败，将使用关键词引擎:', err.message);
      return null; // 返回null表示不可用
    }
  }

  async _getEmbeddings(texts) {
    try {
      const response = await axios.post(
        `${this.baseURL}/embeddings`,
        { model: this.embeddingModel, input: texts },
        {
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 60000,
        }
      );
      if (response.data && response.data.data) {
        return response.data.data.map(item => item.embedding);
      }
      throw new Error('批量Embedding返回格式异常');
    } catch (err) {
      console.warn('[RAG] 批量Embedding API 调用失败:', err.message);
      return null;
    }
  }

  // ============================================================
  // 余弦相似度
  // ============================================================

  _cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, nA = 0, nB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      nA += vecA[i] * vecA[i];
      nB += vecB[i] * vecB[i];
    }
    return nA === 0 || nB === 0 ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
  }

  // ============================================================
  // 本地关键词检索引擎（免API，零成本）
  // ============================================================

  /**
   * 从文本中提取关键词
   */
  _extractKeywords(text) {
    // 按常见分隔符分词
    const words = text.split(/[\s,，。！？、；;:：\n\r\t\(\)（）\[\]【】{}"'「」]+/).filter(w => w.length > 0);
    // 添加单字及以上长度的所有词
    const keywords = new Set();
    for (const word of words) {
      if (word.length >= 1) keywords.add(word);
      // 对长词提取bigram子串
      if (word.length >= 4) {
        for (let i = 0; i < word.length - 1; i++) {
          keywords.add(word.slice(i, i + 2));
        }
      }
    }
    return [...keywords];
  }

  /**
   * 基于关键词匹配的文本检索
   * BM25风格：考虑词频 + 长度归一化
   */
  _keywordSearch(query, chunks, topK) {
    const queryKeywords = this._extractKeywords(query);
    if (queryKeywords.length === 0) return [];

    const avgLen = chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length || 1;
    const k1 = 1.5, b = 0.75;

    // 计算每个chunk的BM25分数
    const scored = chunks.map(chunk => {
      let score = 0;
      const content = chunk.content;
      const docLen = content.length;

      for (const kw of queryKeywords) {
        // 计算词频（在当前chunk中出现的次数）
        let count = 0;
        let pos = 0;
        while (true) {
          pos = content.indexOf(kw, pos);
          if (pos === -1) break;
          count++;
          pos += kw.length;
        }
        if (count > 0) {
          // 简化版BM25：长关键词权重更高
          const weight = kw.length >= 2 ? 1.0 : 0.3;
          const tf = count / (count + k1 * (1 - b + b * docLen / avgLen));
          score += weight * tf;
        }
      }

      return { content, source: chunk.source, score };
    });

    return scored
      .filter(s => s.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * 判断chunks是否包含向量数据
   */
  _hasVectors(chunks) {
    return chunks.length > 0 && Array.isArray(chunks[0].vector) && chunks[0].vector.length > 0;
  }

  // ============================================================
  // 文本处理
  // ============================================================

  _splitText(text, chunkSize = 500, overlap = 100) {
    const chunks = [];
    let start = 0;

    // 匹配中文二级标题行：例如 "一、应用化工学院 ..." 或 "【...】"
    const sectionPattern = /^[一二三四五六七八九十]+[、．]\s*.+|^【.+】$/gm;
    const sections = [];
    let m;
    while ((m = sectionPattern.exec(text)) !== null) {
      sections.push({ pos: m.index, title: m[0].trim() });
    }
    const getSection = (pos) => {
      let s = '概述';
      for (const sec of sections) {
        if (sec.pos <= pos) s = sec.title;
        else break;
      }
      return s;
    };

    while (start < text.length) {
      let end = start + chunkSize;
      if (end >= text.length) {
        const slice = text.slice(start).trim();
        if (slice.length > 10) chunks.push(`【${getSection(start)}】\n${slice}`);
        break;
      }
      const slice = text.slice(start, end);
      const lastPeriod = Math.max(
        slice.lastIndexOf('。'), slice.lastIndexOf('\n'),
        slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('.')
      );
      if (lastPeriod > chunkSize * 0.5) end = start + lastPeriod + 1;
      const chunkText = text.slice(start, end).trim();
      if (chunkText.length > 10) chunks.push(`【${getSection(start)}】\n${chunkText}`);
      start = end - overlap;
    }
    return chunks.filter(c => c.length > 10);
  }

  async _parseTXT(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  async _parsePDF(filePath) {
    if (!pdfParse) throw new Error('PDF解析库未安装，请执行: npm install pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  _getTitleFromPath(filePath) {
    const basename = path.basename(filePath);
    return basename.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
  }

  // ============================================================
  // 核心流程：文档索引
  // ============================================================

  async processDocument(filePath, customTitle = null) {
    const ext = path.extname(filePath).toLowerCase();
    const title = customTitle || this._getTitleFromPath(filePath);

    // 1. 解析文档
    let content;
    if (ext === '.txt') content = await this._parseTXT(filePath);
    else if (ext === '.pdf') content = await this._parsePDF(filePath);
    else throw new Error(`不支持的文件格式: ${ext}，仅支持 .txt 和 .pdf`);

    if (!content || content.trim().length < 10) throw new Error('文档内容为空或过短');

    // 2. 分块
    const chunks = this._splitText(content);
    console.log(`[RAG] 文档 "${title}" 已分割为 ${chunks.length} 个块`);

    // 3. 尝试生成embedding，失败则用空向量占位
    const docId = `doc_${Date.now()}`;
    this.vectorStore.addDocument(docId, title);

    const vectors = await this._getEmbeddings(chunks);
    
    if (vectors) {
      // 向量检索模式
      for (let i = 0; i < chunks.length; i++) {
        this.vectorStore.addChunk(docId, chunks[i], vectors[i], title);
      }
      console.log(`[RAG] 文档 "${title}" 索引完成（向量模式）: ${chunks.length} 个块`);
    } else {
      // 关键词检索模式 - 存储空向量，检索时用关键词引擎
      for (let i = 0; i < chunks.length; i++) {
        this.vectorStore.addChunk(docId, chunks[i], [], title);
      }
      console.log(`[RAG] 文档 "${title}" 索引完成（关键词模式）: ${chunks.length} 个块`);
    }

    return { docId, title, chunkCount: chunks.length };
  }

  // ============================================================
  // 核心流程：知识库检索（向量 → 关键词 fallback）
  // ============================================================

  async retrieve(query, topK = null) {
    const k = topK || this.topK;
    const allChunks = this.vectorStore.getAllChunks();
    if (allChunks.length === 0) return [];

    // 判断是否有向量数据
    if (this._hasVectors(allChunks)) {
      // 向量检索
      const queryVec = await this._getEmbedding(query);
      if (queryVec) {
        const scored = allChunks.map(chunk => ({
          content: chunk.content,
          source: chunk.source,
          score: this._cosineSimilarity(queryVec, chunk.vector),
        }));
        return scored.filter(item => item.score >= this.minScore)
          .sort((a, b) => b.score - a.score).slice(0, k);
      }
    }

    // 关键词检索 fallback
    return this._keywordSearch(query, allChunks, k);
  }

  // ============================================================
  // 问答缓存（省 80% API 费用）
  // ============================================================

  /** 生成缓存 key：问题 + 检索结果 hash */
  _cacheKey(message, retrieved) {
    const chunks = retrieved.map(r => r.source + ':' + r.content.slice(0, 200)).join('|');
    // 简单 hash
    let hash = 0;
    const str = message + chunks;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + c;
      hash |= 0;
    }
    return hash;
  }

  /** 从缓存获取 */
  _cacheGet(key) {
    if (this.answerCache.has(key)) {
      const entry = this.answerCache.get(key);
      // 更新 LRU 顺序
      this.answerCache.delete(key);
      this.answerCache.set(key, entry);
      return entry;
    }
    return null;
  }

  /** 写入缓存 */
  _cacheSet(key, value) {
    // LRU 淘汰
    if (this.answerCache.size >= this.CACHE_MAX) {
      const oldestKey = this.answerCache.keys().next().value;
      this.answerCache.delete(oldestKey);
    }
    this.answerCache.set(key, value);
  }

  // ============================================================
  // 自学成长：把真实问答加入知识库
  // ============================================================

  /**
   * 把一段真实问答加入知识库
   * @param {string} question - 新生问的问题
   * @param {string} answer - 你给的靠谱回答
   * @returns {{ success: boolean, chunkCount: number, docTitle: string }}
   */
  addQA(question, answer) {
    const q = question.replace(/<[^>]*>/g, '').trim();
    const a = answer.replace(/<[^>]*>/g, '').trim();
    if (!q || !a) throw new Error('问题和答案都不能为空');

    // 把问答写入 "真实问答收集" 文档（追加模式）
    const qaFile = path.join(__dirname, '..', 'data', 'documents', '99-真实问答收集.txt');
    const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const entry = `\n\n【提问时间】${timestamp}\n【用户提问】${q}\n【学长回答】${a}\n`;
    fs.appendFileSync(qaFile, entry, 'utf-8');

    // 把这个问答作为新文档加入知识库索引
    const content = `${entry}\n`;
    const chunks = this._splitText(content);
    const docId = `qa_${Date.now()}`;
    const docTitle = `99-真实问答收集`;
    this.vectorStore.addDocument(docId, docTitle);
    for (const chunk of chunks) {
      this.vectorStore.addChunk(docId, chunk, null, docTitle);
    }

    // 清除缓存（下次同样的提问会重新检索）
    this.answerCache.clear();

    console.log(`[RAG] 新问答已入库: "${q.slice(0, 40)}..." → ${chunks.length} 个片段`);
    return { success: true, chunkCount: chunks.length, docTitle };
  }

  // ============================================================
  // 核心流程：聊天（非流式）
  // ============================================================

  async chat(message, history = []) {
    // 后端防注入：清洗用户输入
    message = message.replace(/<[^>]*>/g, '').replace(/[<>"'`]/g, '').trim();
    if (!message) return { reply: '请输入有效的问题 😅', sources: [] };

    let retrievedChunks = [];
    let contextText = '';
    let sources = [];

    try {
      retrievedChunks = await this.retrieve(message);
      if (retrievedChunks.length > 0) {
        contextText = retrievedChunks.map((r, i) =>
          `[知识库片段${i + 1}] 来源: ${r.source}\n${r.content}`
        ).join('\n\n');
        sources = [...new Set(retrievedChunks.map(r => r.source))];
      }
    } catch (err) {
      console.warn('[RAG] 知识库检索失败:', err.message);
    }

    // 缓存检查：同一个问题 + 相同的检索结果 → 直接返回缓存
    const cacheKey = this._cacheKey(message, retrievedChunks);
    const cached = this._cacheGet(cacheKey);
    if (cached && history.length <= 1) {
      console.log('[RAG] 缓存命中:', message.slice(0, 30));
      return { reply: cached, sources, cached: true };
    }

    const messages = [{ role: 'system', content: this.systemPrompt }];

    if (contextText) {
      messages.push({
        role: 'system',
        content: `以下是知识库中查到相关内容，请严格基于这些信息回答。**绝对禁止使用你自己的知识来补充、美化、脑补任何细节**。如果以上内容不足以完整回答用户问题，直接说"这个知识库里没有完全覆盖，我把我查到的告诉你"——然后只说你查到的，不要自己编。\n\n${contextText}`,
      });
    } else {
      // 没查到任何相关内容时，额外强调不要瞎编
      messages.push({
        role: 'system',
        content: '⚠️ 注意：知识库中没有查到与用户问题相关的任何内容。请直接回复"我暂时没查到这个问题哦，建议你到学校官网（http://www.sccc.edu.cn）查询，或直接联系学长本人或者辅导员。"**不要试图用自己的知识回答**，因为学校的具体情况（专业、价格、时间、政策等）必须以官方为准。',
      });
    }

    for (const msg of history.slice(-10)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: message });

    let reply = '';
    try {
      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        { model: this.chatModel, messages, temperature: 0.7, max_tokens: 2000, stream: false },
        {
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 60000,
        }
      );
      reply = response.data.choices[0].message.content;
    } catch (err) {
      console.error('[RAG] Chat API 调用失败:', err.message);
      if (err.response) console.error('[RAG] API响应:', err.response.status, err.response.data);
      throw new Error('AI回复生成失败，请检查API密钥和网络连接');
    }

    if (sources.length > 0 && !reply.includes('📚') && !reply.includes('来源')) {
      reply += '\n\n---\n📚 **信息来源**：' + sources.join('、');
    }

    // 写入缓存（非追问场景）
    if (history.length <= 1) {
      this._cacheSet(cacheKey, reply);
    }

    return { reply, sources, retrieved: retrievedChunks };
  }

  // ============================================================
  // 核心流程：聊天（SSE流式）
  // ============================================================

  async *chatStream(message, history = []) {
    // 后端防注入：清洗用户输入
    message = message.replace(/<[^>]*>/g, '').replace(/[<>"'`]/g, '').trim();
    if (!message) {
      yield { type: 'error', data: '请输入有效的问题 😅' };
      return;
    }

    let retrievedChunks = [];
    let contextText = '';
    let sources = [];

    try {
      retrievedChunks = await this.retrieve(message);
      if (retrievedChunks.length > 0) {
        contextText = retrievedChunks.map((r, i) =>
          `[知识库片段${i + 1}] 来源: ${r.source}\n${r.content}`
        ).join('\n\n');
        sources = [...new Set(retrievedChunks.map(r => r.source))];
      }
    } catch (err) {
      console.warn('[RAG] 知识库检索失败:', err.message);
    }

    // 缓存检查
    const cacheKey = this._cacheKey(message, retrievedChunks);
    const cached = this._cacheGet(cacheKey);
    if (cached && history.length <= 1) {
      console.log('[RAG] 流式缓存命中:', message.slice(0, 30));
      // 逐字输出缓存内容（模拟流式效果）
      for (const char of cached) {
        yield { type: 'token', data: char };
      }
      yield { type: 'done' };
      return;
    }

    yield { type: 'sources', data: sources };

    const messages = [{ role: 'system', content: this.systemPrompt }];

    if (contextText) {
      messages.push({
        role: 'system',
        content: `以下是知识库中查到相关内容，请严格基于这些信息回答。**绝对禁止使用你自己的知识来补充、美化、脑补任何细节**。如果以上内容不足以完整回答用户问题，直接说"这个知识库里没有完全覆盖，我把我查到的告诉你"——然后只说你查到的，不要自己编。\n\n${contextText}`,
      });
    } else {
      // 没查到任何相关内容时，额外强调不要瞎编
      messages.push({
        role: 'system',
        content: '⚠️ 注意：知识库中没有查到与用户问题相关的任何内容。请直接回复"我暂时没查到这个问题哦，建议你到学校官网（http://www.sccc.edu.cn）查询，或直接联系学长本人或者辅导员。"**不要试图用自己的知识回答**，因为学校的具体情况（专业、价格、时间、政策等）必须以官方为准。',
      });
    }

    for (const msg of history.slice(-10)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: message });

    try {
      yield { type: 'start', data: null };

      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        { model: this.chatModel, messages, temperature: 0.7, max_tokens: 2000, stream: true },
        {
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 120000,
        }
      );

      let fullReply = '';
      const stream = response.data;
      const decoder = new (require('string_decoder').StringDecoder)('utf-8');
      let buffer = '';

      for await (const chunk of stream) {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              fullReply += content;
              yield { type: 'token', data: content };
            }
          } catch (e) { /* skip */ }
        }
      }

      if (sources.length > 0 && !fullReply.includes('📚') && !fullReply.includes('来源')) {
        const sourceNote = '\n\n---\n📚 **信息来源**：' + sources.join('、');
        yield { type: 'token', data: sourceNote };
        fullReply += sourceNote;
      }
      yield { type: 'done', data: null };
      // 流式完成后写入缓存
      if (history.length <= 1 && fullReply) {
        this._cacheSet(cacheKey, fullReply);
      }
    } catch (err) {
      console.error('[RAG] 流式API调用失败:', err.message);
      yield { type: 'error', data: 'AI回复生成失败，请检查API密钥和网络连接' };
    }
  }
}

module.exports = { RAGEngine };
