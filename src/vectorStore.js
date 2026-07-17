/**
 * 向量存储模块 - 使用本地JSON文件存储文档chunks和向量
 * 部署简单，无需额外数据库服务
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'vector_store.json');

// 默认空存储结构
const DEFAULT_STORE = {
  documents: [],   // 文档元信息
  chunks: [],      // 文本块 + 向量
};

class VectorStore {
  constructor() {
    this.store = this._load();
  }

  /**
   * 从磁盘加载存储
   */
  _load() {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[VectorStore] 读取存储文件失败，将使用默认空存储:', err.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }

  /**
   * 保存存储到磁盘
   */
  _save() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2), 'utf-8');
  }

  /**
   * 添加文档到存储
   * @param {string} docId - 文档ID
   * @param {string} title - 文档标题
   * @returns {object} 文档记录
   */
  addDocument(docId, title) {
    const doc = {
      id: docId,
      title,
      uploadedAt: new Date().toISOString(),
      chunkCount: 0,
    };
    this.store.documents.push(doc);
    this._save();
    return doc;
  }

  /**
   * 删除文档及其所有chunks
   * @param {string} docId
   */
  deleteDocument(docId) {
    this.store.documents = this.store.documents.filter(d => d.id !== docId);
    this.store.chunks = this.store.chunks.filter(c => c.docId !== docId);
    this._save();
  }

  /**
   * 获取所有文档列表
   */
  getDocuments() {
    return this.store.documents;
  }

  /**
   * 获取单个文档
   * @param {string} docId
   */
  getDocument(docId) {
    return this.store.documents.find(d => d.id === docId);
  }

  /**
   * 添加文本块（含向量）
   * @param {string} docId
   * @param {string} content - 文本内容
   * @param {number[]} vector - embedding向量
   * @param {string} source - 来源文档名
   */
  addChunk(docId, content, vector, source) {
    const chunk = {
      id: `chunk_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      docId,
      content,
      vector,
      source,
    };
    this.store.chunks.push(chunk);

    // 更新文档chunk计数
    const doc = this.store.documents.find(d => d.id === docId);
    if (doc) doc.chunkCount = this.store.chunks.filter(c => c.docId === docId).length;

    this._save();
    return chunk;
  }

  /**
   * 获取文档的所有chunks
   * @param {string} docId
   */
  getChunksByDoc(docId) {
    return this.store.chunks.filter(c => c.docId === docId);
  }

  /**
   * 获取所有chunks数量
   */
  getChunkCount() {
    return this.store.chunks.length;
  }

  /**
   * 获取所有chunks（用于检索）
   */
  getAllChunks() {
    return this.store.chunks;
  }

  /**
   * 清空所有数据
   */
  clear() {
    this.store = JSON.parse(JSON.stringify(DEFAULT_STORE));
    this._save();
  }

  /**
   * 获取存储统计信息
   */
  getStats() {
    return {
      documentCount: this.store.documents.length,
      chunkCount: this.store.chunks.length,
      documents: this.store.documents.map(d => ({
        ...d,
        // 返回时不暴露向量数据
      })),
    };
  }
}

module.exports = VectorStore;
