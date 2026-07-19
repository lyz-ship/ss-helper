/**
 * SS学长来帮你 - 后端API服务器
 * 提供聊天接口、知识库管理接口
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { RAGEngine } = require('./src/rag');

// ============================================================
// 配置
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const UPLOAD_DIR = path.join(__dirname, 'data', 'documents');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 初始化RAG引擎（自动检测用哪个API）
const apiKey = process.env.DEEPSEEK_API_KEY || process.env.SILICONFLOW_API_KEY || '';
const isDeepSeek = !!process.env.DEEPSEEK_API_KEY;
const rag = new RAGEngine({
  apiKey,
  baseURL: isDeepSeek ? 'https://api.deepseek.com/v1' : 'https://api.siliconflow.cn/v1',
  chatModel: isDeepSeek ? 'deepseek-v4-flash' : 'deepseek-ai/DeepSeek-V4-Flash',
  embeddingModel: isDeepSeek ? 'deepseek-embedding' : 'BAAI/bge-m3',
});

// ============================================================
// 中间件
// ============================================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 托管前端静态文件（缓存策略：图片强缓存1天，其他不缓存）
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders: (res, filePath) => {
    // 图片文件：强缓存24小时 + ETag
    if (/\.(webp|jpe?g|png|gif|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('Expires', new Date(Date.now() + 86400000).toUTCString());
    }
    // HTML/CSS/JS：不缓存，强制从服务器获取最新
    else if (/\.(html?|css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  }
}));

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // 保留原始文件名，添加时间戳避免重名
    const safeName = file.originalname.replace(/[^a-zA-Z0-9\u4e00-\u9fa5.\-_]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .txt 和 .pdf 文件'));
    }
  },
});

// ============================================================
// 管理后台鉴权中间件
// ============================================================
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '未授权访问，请在管理后台登录' });
  }
  next();
}

// ============================================================
// API 路由 - 聊天
// ============================================================

/**
 * POST /api/chat - 非流式聊天
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    console.log(`[API] 收到聊天请求: "${message.slice(0, 50)}..."`);

    const result = await rag.chat(message, history || []);
    res.json({
      reply: result.reply,
      sources: result.sources,
    });
  } catch (err) {
    console.error('[API] 聊天错误:', err.message);
    res.status(500).json({
      error: '抱歉，我暂时没法回答这个问题，请稍后再试。',
      detail: err.message,
    });
  }
});

/**
 * POST /api/chat/stream - 流式聊天（SSE）
 * 用 Node 原生 fetch 实现，直接转发上游 SSE 流
 */
app.post('/api/chat/stream', async (req, res) => {
  const { message, history } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  console.log(`[API] 收到流式聊天请求: "${message.slice(0, 50)}..."`);

  // 设置SSE响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    // 1. 知识库检索
    const retrieved = await rag.retrieve(message);
    const sources = [...new Set(retrieved.map(r => r.source))];
    res.write(`data: ${JSON.stringify({ type: 'sources', data: sources })}\n\n`);

    // 2. 构造消息列表
    const messages = [{ role: 'system', content: rag.systemPrompt }];
    if (retrieved.length > 0) {
      const contextText = retrieved.map((r, i) =>
        `[知识库片段${i + 1}] 来源: ${r.source}\n${r.content}`
      ).join('\n\n');
      messages.push({
        role: 'system',
        content: `以下是知识库中与用户问题相关的内容，请优先基于这些信息回答。如果信息不足以回答，可以补充你的常识但需说明。\n\n${contextText}`,
      });
    }
    for (const msg of (history || []).slice(-10)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: message });

    // 3. 发送开始标记
    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    // 4. 用原生 fetch 流式调用硅基流动 API
    const response = await fetch(`${rag.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rag.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: rag.chatModel,
        messages,
        temperature: 0.7,
        max_tokens: 2000,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
    }

    // 5. 解析上游 SSE 流，转发给客户端
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullReply = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullReply += content;
            // 转发给客户端
            res.write(`data: ${JSON.stringify({ type: 'token', data: content })}\n\n`);
          }
        } catch (e) { /* skip */ }
      }
    }

    // 6. 追加来源信息
    if (sources.length > 0 && !fullReply.includes('📚') && !fullReply.includes('来源')) {
      const sourceNote = '\n\n---\n📚 **信息来源**：' + sources.join('、');
      res.write(`data: ${JSON.stringify({ type: 'token', data: sourceNote })}\n\n`);
    }

    // 7. 结束
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[API] 流式聊天错误:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    if (!req.destroyed) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: 'AI回复失败: ' + err.message })}\n\n`);
      res.end();
    }
  }
});

// ============================================================
// API 路由 - 知识库管理
// ============================================================

/**
 * POST /api/admin/login - 管理员登录
 */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

/**
 * POST /api/admin/documents/upload - 上传并索引文档
 */
app.post('/api/admin/documents/upload', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const filePath = req.file.path;
    const customTitle = req.body.title || null;

    console.log(`[API] 开始处理文档: ${req.file.originalname}`);

    const result = await rag.processDocument(filePath, customTitle);

    res.json({
      success: true,
      message: `文档 "${result.title}" 索引成功，共 ${result.chunkCount} 个知识片段`,
      document: result,
    });
  } catch (err) {
    console.error('[API] 文档处理错误:', err.message);
    // 清理上传失败的文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: `文档处理失败: ${err.message}` });
  }
});

/**
 * GET /api/admin/documents - 获取文档列表
 */
app.get('/api/admin/documents', adminAuth, (req, res) => {
  const docs = rag.vectorStore.getDocuments();
  res.json({ documents: docs });
});

/**
 * DELETE /api/admin/documents/:id - 删除文档
 */
app.delete('/api/admin/documents/:id', adminAuth, (req, res) => {
  const docId = req.params.id;
  const doc = rag.vectorStore.getDocument(docId);
  if (!doc) {
    return res.status(404).json({ error: '文档不存在' });
  }

  rag.vectorStore.deleteDocument(docId);
  res.json({ success: true, message: `文档 "${doc.title}" 已删除` });
});

/**
 * GET /api/admin/stats - 获取知识库统计
 */
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = rag.vectorStore.getStats();
  res.json(stats);
});

/**
 * POST /api/admin/retrieve-test - 测试知识库检索
 */
app.post('/api/admin/retrieve-test', adminAuth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: '请输入查询内容' });

    const results = await rag.retrieve(query, 10);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// API 路由 - 系统检查
// ============================================================

/**
 * POST /api/knowledge/add - 把真实问答加入知识库（自学成长）
 * Body: { question, answer }
 */
app.post('/api/knowledge/add', adminAuth, async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: '需要提供 question 和 answer' });
    }
    const result = rag.addQA(question, answer);
    console.log(`[API] 新知识入库: "${question.slice(0, 30)}..."`);
    res.json({ success: true, message: '问答已加入知识库 ✅', ...result });
  } catch (err) {
    console.error('[API] 知识入库失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/health - 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    knowledgeBase: {
      documents: rag.vectorStore.getDocuments().length,
      chunks: rag.vectorStore.getChunkCount(),
    },
  });
});

// ============================================================
// 前端路由 - SPA降级
// ============================================================

// 管理后台路由
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 默认路由 - 跳转到主页
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 错误处理
// ============================================================
app.use((err, req, res, next) => {
  console.error('[API] 未捕获错误:', err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件大小不能超过20MB' });
    }
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

// ============================================================
// 启动服务
// ============================================================
app.listen(PORT, () => {
  console.log('============================================');
  console.log('  SS学长来帮你 - 校园AI助手');
  console.log('============================================');
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  聊天页面: http://localhost:${PORT}`);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log(`  API健康检查: http://localhost:${PORT}/api/health`);
  console.log('============================================');
  console.log(`  知识库状态: ${rag.vectorStore.getDocuments().length} 个文档, ${rag.vectorStore.getChunkCount()} 个知识片段`);
  console.log('============================================');
  if (!apiKey) {
    console.warn('  ⚠️  警告: 未设置 API Key（请配置 DEEPSEEK_API_KEY 或 SILICONFLOW_API_KEY）');
    console.log('============================================');
  }
});
