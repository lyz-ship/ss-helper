/**
 * SS学长来帮你 - 前端聊天应用
 * 移动端优先 · SSE流式响应 · 微信兼容
 */

(function() {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================
  const CONFIG = {
    apiBase: '',  // 同域，留空
    storageKey: 'ss_helper_history',
    maxHistory: 100,
    welcomeMessage: '👋 科技改变生活，SS永伴你左右\n\n**直接打字问我吧，就跟聊天一样！** 😎',
    suggestions: [
      '📋 报道要带啥证件',
      '🏠 四人间怎么抢',
      '🗺️ 校园地图',
      '🎒 开学要准备什么',
      '🛏️ 床上六件套值得买吗',
      '🚗 报道路线',
    ],
  };

  // ============================================================
  // DOM 引用
  // ============================================================
  const chatArea = document.getElementById('chatArea');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const favTip = document.getElementById('favTip');
  const shareGuide = document.getElementById('shareGuide');

  // ============================================================
  // 状态
  // ============================================================
  let isSending = false;
  let history = [];

  // ============================================================
  // 工具函数
  // ============================================================

  /** 格式化时间 */
  function getTimeStr() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  /** 生成唯一ID */
  function genId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  }

  /** 简单的Markdown转HTML（支持粗体、换行、链接、列表） */
  function mdToHtml(text) {
    if (!text) return '';
    return text
      // 转义HTML（但图片和链接的<>要保留）
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // 图片 ![alt](url) — 可点击放大 + 路径补全（兜底）
      // 兼容：英文括号 ()、全角中文括号 （）、中文感叹号 ！
      .replace(/[！!]\s*\[(.*?)\]\s*[（(](.*?)[)）]/g, (m, alt, url) => {
        let fixedUrl = url.trim();
        // 兜底1：缺 /images/ 前缀时补上
        if (!fixedUrl.startsWith('/images/') && !fixedUrl.startsWith('http') && !fixedUrl.startsWith('data:')) {
          fixedUrl = '/images/' + fixedUrl.replace(/^\.?\//, '');
        }
        // 兜底2：缺扩展名时自动加 .jpeg
        if (fixedUrl.startsWith('/images/') && !/\.[a-zA-Z]+$/.test(fixedUrl.split('/').pop())) {
          fixedUrl = fixedUrl + '.jpeg';
        }
        return `<img src="${fixedUrl}" alt="${alt}" class="chat-image" data-src="${fixedUrl}" style="max-width:100%;border-radius:12px;margin:8px 0;cursor:pointer;" loading="lazy" onerror="this.style.opacity=0.3;this.alt='图片加载失败'">`;
      })
      // 兜底3：识别"配图：xxx" / "插入图片：xxx" / "图片：xxx" 的纯文字描述，转成图片
      .replace(/[（(]\s*(?:配图|插入图片|插入配图|图片|配|图|\[图片\]|\[配图\]|\[图\])\s*[:：]?\s*(\/?(?:images\/)?[a-zA-Z0-9_\-]+\.(?:jpg|jpeg|png))\s*[)）]/gi, (m, url) => {
        let fixedUrl = url.trim();
        if (!fixedUrl.startsWith('/images/') && !fixedUrl.startsWith('http') && !fixedUrl.startsWith('data:')) {
          fixedUrl = '/images/' + fixedUrl.replace(/^\.?\//, '');
        }
        return `<img src="${fixedUrl}" alt="" class="chat-image" data-src="${fixedUrl}" style="max-width:100%;border-radius:12px;margin:8px 0;cursor:pointer;" loading="lazy" onerror="this.style.opacity=0.3;this.alt='图片加载失败'">`;
      })
      // 粗体 **text**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // 行内代码 `code`
      .replace(/`(.+?)`/g, '<code style="background:#F0F0F0;padding:2px 6px;border-radius:4px;font-size:0.9em;">$1</code>')
      // 换行
      .replace(/\n/g, '<br>')
      // 链接
      .replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  }

  /** 前端防注入：清洗用户输入，去掉HTML标签和危险字符 */
  function sanitizeInput(text) {
    if (!text) return '';
    return text
      .replace(/<[^>]*>/g, '')       // 去掉 HTML 标签
      .replace(/[<>"'`]/g, '')       // 去掉特殊字符
      .replace(/javascript:/gi, '')   // 去掉 js 协议
      .replace(/on\w+\s*=/gi, '')    // 去掉 on* 事件属性
      .trim();
  }

  /** 显示Toast提示（兼容微信浏览器） */
  function showToast(msg, duration = 2000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  /** 滚动到底部（平滑） */
  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatArea.scrollTop = chatArea.scrollHeight;
    });
  }

  // ============================================================
  // 消息渲染
  // ============================================================

  /** 添加消息到聊天区域 */
  function addMessage(role, content, isHtml = false) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.id = genId();

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (isHtml) {
      bubble.innerHTML = content;
    } else {
      bubble.innerHTML = mdToHtml(content);
    }

    div.appendChild(bubble);

    // 如果是AI消息，添加头像（通过CSS伪元素实现）
    chatArea.appendChild(div);
    scrollToBottom();
    return div;
  }

  /** 添加欢迎消息（居中布局） */
  function showWelcome() {
    const div = document.createElement('div');
    div.className = 'welcome-layout';
    div.id = 'welcomeMsg';

    // 头像
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'welcome-avatar';
    avatarWrap.innerHTML = '<div class="welcome-avatar-inner"></div><div class="online-dot"></div>';

    // 标题
    const title = document.createElement('div');
    title.className = 'welcome-title';
    title.textContent = 'SS学长';

    // 副标题
    const sub1 = document.createElement('div');
    sub1.className = 'welcome-sub';
    sub1.textContent = '四川化工职业技术学院';
    const sub2 = document.createElement('div');
    sub2.className = 'welcome-sub';
    sub2.textContent = '新生专属AI助手 · 24h在线';

    // 免责声明
    const disc = document.createElement('div');
    disc.className = 'welcome-disclaimer';
    disc.textContent = '⚠️ AI内容仅供参考，有疑惑的地方找学长本人';

    // 气泡提示
    const wechatHint = document.createElement('div');
    wechatHint.className = 'welcome-wechat-hint';
    wechatHint.textContent = '⬆️ 右上角点击气泡图标添加本人';

    // 快捷问题
    const suggestWrap = document.createElement('div');
    suggestWrap.className = 'welcome-suggestions';
    CONFIG.suggestions.forEach(text => {
      const chip = document.createElement('button');
      chip.className = 'welcome-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => sendMessage(text));
      suggestWrap.appendChild(chip);
    });

    div.appendChild(avatarWrap);
    div.appendChild(title);
    div.appendChild(sub1);
    div.appendChild(sub2);
    div.appendChild(disc);
    div.appendChild(wechatHint);
    div.appendChild(suggestWrap);
    chatArea.appendChild(div);
  }

  /** 显示打字指示器 */
  function showTyping() {
    const div = document.createElement('div');
    div.className = 'message ai';
    div.id = 'typingIndicator';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

    div.appendChild(bubble);
    chatArea.appendChild(div);
    scrollToBottom();
    return div;
  }

  /** 更新流式输出消息 */
  function updateStreamMessage(div, content) {
    const bubble = div.querySelector('.bubble');
    if (bubble) {
      bubble.innerHTML = mdToHtml(content);
      scrollToBottom();
    }
  }

  /** 在流式消息末尾添加来源 */
  function appendSources(div, sources) {
    if (!sources || sources.length === 0) return;
    const bubble = div.querySelector('.bubble');
    if (!bubble) return;

    const sourceHtml = sources.map(s => `<span class="source-tag">📚 ${s}</span>`).join(' ');
    bubble.innerHTML += `<br><div style="margin-top:8px;">${sourceHtml}</div>`;
    scrollToBottom();
  }

  /** 添加时间分隔线 */
  function addTimeSeparator(time) {
    const div = document.createElement('div');
    div.className = 'message-time';
    div.textContent = time || getTimeStr();
    chatArea.appendChild(div);
  }

  // ============================================================
  // 核心：发送消息 & SSE流式接收
  // ============================================================

  async function sendMessage(text) {
    const message = (text || messageInput.value).trim();
    if (!message || isSending) return;

    // 清空输入
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // 添加用户消息
    addMessage('user', message);
    addTimeSeparator();

    // 添加历史记录
    history.push({ role: 'user', content: message });

    // 显示打字中
    const typingDiv = showTyping();
    isSending = true;
    sendBtn.disabled = true;

    // 流式消息容器（最终替换打字指示器）
    const aiMsgDiv = document.createElement('div');
    aiMsgDiv.className = 'message ai';
    aiMsgDiv.id = genId();
    const aiBubble = document.createElement('div');
    aiBubble.className = 'bubble';
    aiMsgDiv.appendChild(aiBubble);

    let fullReply = '';
    let streamStarted = false;
    let sources = [];
    let hasError = false;

    // 超时控制：60秒内没收到任何数据就报错
    const TIMEOUT_MS = 60000;
    const startTime = Date.now();
    let firstTokenTimer = setTimeout(() => {
      if (!streamStarted) {
        hasError = true;
        if (typingDiv.parentNode) typingDiv.remove();
        const errDiv = document.createElement('div');
        errDiv.className = 'message error';
        errDiv.innerHTML = `<div class="bubble">⚠️ 响应超时，可能是网络问题。请刷新页面或稍后再试。</div>`;
        chatArea.appendChild(errDiv);
        scrollToBottom();
        isSending = false;
        sendBtn.disabled = false;
      }
    }, 15000); // 15秒内连 start 都没收到就算超时

    try {
      // 使用 fetch SSE 流式请求 + AbortController
      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(`${CONFIG.apiBase}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history: history.slice(-8),
        }),
        signal: controller.signal,
      });

      clearTimeout(fetchTimer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);

            // 一旦收到任何事件，清除首字超时
            if (!streamStarted) {
              streamStarted = true;
              clearTimeout(firstTokenTimer);
            }

            switch (data.type) {
              case 'sources':
                sources = data.data || [];
                break;

              case 'start':
                if (typingDiv.parentNode) {
                  typingDiv.remove();
                }
                if (!aiMsgDiv.parentNode) chatArea.appendChild(aiMsgDiv);
                break;

              case 'token':
                if (typingDiv.parentNode) {
                  typingDiv.remove();
                }
                if (!aiMsgDiv.parentNode) chatArea.appendChild(aiMsgDiv);
                fullReply += data.data;
                aiBubble.innerHTML = mdToHtml(fullReply);
                scrollToBottom();
                break;

              case 'done':
                break;

              case 'error':
                throw new Error(data.data);
            }
          } catch (e) {
            if (e.message && e.message.includes(dataStr)) throw e;
            // 解析失败的JSON跳过
          }
        }
      }

      clearTimeout(firstTokenTimer);

      // 流正常结束
      if (typingDiv.parentNode) {
        typingDiv.remove();
        if (!aiMsgDiv.parentNode) chatArea.appendChild(aiMsgDiv);
      }
      if (!aiMsgDiv.parentNode) chatArea.appendChild(aiMsgDiv);

      // 如果有内容就用内容，没有就给个友好提示
      if (!fullReply.trim()) {
        aiBubble.innerHTML = '抱歉，没有获取到回复内容。请重新问一次吧 🙏';
      } else {
        aiBubble.innerHTML = mdToHtml(fullReply);
      }

      // 添加来源
      appendSources(aiMsgDiv, sources);

      // 保存历史
      history.push({ role: 'assistant', content: fullReply || '（无回复）' });
      if (history.length > CONFIG.maxHistory) {
        history = history.slice(-CONFIG.maxHistory);
      }
      saveHistory();

    } catch (err) {
      clearTimeout(firstTokenTimer);
      console.error('[Chat] 请求失败:', err);
      hasError = true;

      // 移除打字指示器
      if (typingDiv.parentNode) typingDiv.remove();

      // 区分错误类型
      let errorMsg = '😅 哎呀，网络开小差了，稍后再试试吧！';
      if (err.name === 'AbortError') {
        errorMsg = '⏱️ 请求超时了，请重试一下';
      } else if (err.message && err.message.includes('Failed to fetch')) {
        errorMsg = '🔌 连接不上服务器，请检查网络后重试';
      } else if (err.message && err.message.includes('HTTP 5')) {
        errorMsg = '⚠️ 服务器暂时出问题了，请稍后再试';
      }

      const errDiv = document.createElement('div');
      errDiv.className = 'message error';
      errDiv.innerHTML = `<div class="bubble">${errorMsg}<br><button onclick="this.parentElement.parentElement.remove()" style="margin-top:8px;padding:4px 12px;background:var(--primary);color:white;border:none;border-radius:12px;font-size:13px;cursor:pointer;">关闭</button></div>`;
      chatArea.appendChild(errDiv);
      scrollToBottom();
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      messageInput.focus();
    }
  }

  // ============================================================
  // 聊天历史管理
  // ============================================================

  function saveHistory() {
    try {
      const toSave = history.slice(-CONFIG.maxHistory);
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(toSave));
    } catch (e) {
      // localStorage可能满，忽略
    }
  }

  function loadHistory() {
    try {
      const saved = localStorage.getItem(CONFIG.storageKey);
      if (saved) {
        history = JSON.parse(saved);
        // 恢复历史消息
        for (const msg of history) {
          addMessage(msg.role, msg.content);
        }
      }
    } catch (e) {
      // 解析失败则清空
      localStorage.removeItem(CONFIG.storageKey);
    }
  }

  function clearHistory() {
    history = [];
    localStorage.removeItem(CONFIG.storageKey);
    // 清空聊天区域
    chatArea.innerHTML = '';
    showWelcome();
    addTimeSeparator(getTimeStr());
  }

  // ============================================================
  // 微信兼容处理
  // ============================================================

  /** 处理微信浏览器特性 */
  function initWeChatCompat() {
    // 检测是否在微信中
    const isWeChat = /MicroMessenger/i.test(navigator.userAgent);
    document.body.classList.toggle('in-wechat', isWeChat);

    if (isWeChat) {
      // 微信内禁用长按菜单中的"复制图片"等干扰
      document.addEventListener('contextmenu', e => {
        if (e.target.closest('.bubble')) {
          e.preventDefault();
        }
      });

      // 尝试调用微信JS-SDK（如果已接入）
      if (typeof WeixinJSBridge !== 'undefined' || window.wx) {
        setupWeChatSDK();
      }
    }

    // 微信 iOS 下拉露底问题
    document.body.addEventListener('touchmove', function(e) {
      if (e.target.closest('.chat-area')) return;
      // 不阻止默认行为，但防止页面整体下拉
    }, { passive: true });
  }

  /** 微信JS-SDK设置（可选接入） */
  function setupWeChatSDK() {
    console.log('[WeChat] 微信环境检测通过');
    // 如果有微信JS-SDK配置，可以在这里设置分享等能力
    // 详见部署文档
  }

  /** 复制链接（兼容微信） */
  function copyLink() {
    const url = window.location.href;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('✅ 链接已复制，快去分享吧！');
      }).catch(() => {
        fallbackCopy(url);
      });
    } else {
      fallbackCopy(url);
    }
  }

  /** 降级复制方案（兼容微信） */
  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      const success = document.execCommand('copy');
      if (success) {
        showToast('✅ 链接已复制！');
      } else {
        showToast('💡 请长按链接手动复制');
      }
    } catch (e) {
      showToast('💡 请长按链接手动复制');
    }

    document.body.removeChild(textarea);
  }

  // ============================================================
  // "添加到收藏"提示
  // ============================================================

  function initFavTip() {
    // 检查是否已关闭过
    if (localStorage.getItem('ss_helper_fav_tip_closed')) {
      favTip.style.display = 'none';
      return;
    }

    // 3秒后显示
    setTimeout(() => {
      favTip.classList.remove('hide');
      favTip.style.display = 'flex';
    }, 3000);

    // 关闭
    document.getElementById('closeFavTip').addEventListener('click', (e) => {
      e.stopPropagation();
      favTip.classList.add('hide');
      localStorage.setItem('ss_helper_fav_tip_closed', 'true');
      setTimeout(() => { favTip.style.display = 'none'; }, 300);
    });

    // 点击整个提示 → 弹出收藏引导
    favTip.addEventListener('click', () => {
      favTip.classList.add('hide');
      localStorage.setItem('ss_helper_fav_tip_closed', 'true');
      setTimeout(() => { favTip.style.display = 'none'; }, 300);
      showShareGuide();
    });
  }

  /** 显示收藏/分享引导 */
  function showShareGuide() {
    shareGuide.classList.remove('hide');
    shareGuide.style.display = 'flex';
  }

  /** 关闭分享引导 */
  function closeShareGuide() {
    shareGuide.classList.add('hide');
    setTimeout(() => { shareGuide.style.display = 'none'; }, 300);
  }

  // ============================================================
  // 输入框自动调整高度
  // ============================================================

  function autoResize() {
    messageInput.style.height = 'auto';
    const newHeight = Math.min(messageInput.scrollHeight, 100);
    messageInput.style.height = newHeight + 'px';
  }

  // ============================================================
  // 初始化
  // ============================================================

  function init() {
    // 加载历史或显示欢迎
    loadHistory();
    if (history.length === 0) {
      showWelcome();
      addTimeSeparator(getTimeStr());
    }

    // 微信兼容
    initWeChatCompat();

    // "添加到收藏"提示
    initFavTip();

    // 事件绑定
    sendBtn.addEventListener('click', () => sendMessage());
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    messageInput.addEventListener('input', autoResize);

    // 点击页面关闭分享引导
    shareGuide.addEventListener('click', (e) => {
      if (e.target === shareGuide) closeShareGuide();
    });
    document.getElementById('shareGuideClose').addEventListener('click', closeShareGuide);
    document.getElementById('shareGuideCopy').addEventListener('click', () => {
      copyLink();
      closeShareGuide();
    });

    // 清空历史（头部按钮）
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('确定要清空聊天记录吗？')) {
          clearHistory();
          showToast('🗑️ 聊天记录已清空');
        }
      });
    }

    // 复制链接按钮
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', copyLink);
    }

    // 页面可见性变化时重新聚焦
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        setTimeout(() => messageInput.focus(), 300);
      }
    });

    // 初始聚焦
    setTimeout(() => messageInput.focus(), 500);

    // 防卡死：每30秒检测一次，如果输入框被锁定超过60秒就自动解锁
    let lastUnlockTime = Date.now();
    setInterval(() => {
      if (isSending && Date.now() - lastUnlockTime > 60000) {
        isSending = false;
        sendBtn.disabled = false;
        lastUnlockTime = Date.now();
        console.warn('[防卡死] 自动解锁输入框');
        showToast('🔓 已自动恢复，可以继续提问');
      }
      if (!isSending) {
        lastUnlockTime = Date.now();
      }
    }, 10000);

    // 初始化图片查看器（点击放大+下载）
    initImageViewer();
    // 初始化微信二维码
    initWechat();

    console.log('[SS学长] 初始化完成 🚀');
  }

  /** 初始化图片查看器（点击放大） */
  function initImageViewer() {
    const viewer = document.getElementById('imageViewer');
    const img = document.getElementById('imageViewerImg');
    const bg = document.getElementById('imageViewerBg');
    const closeBtn = document.getElementById('imageViewerClose');

    document.getElementById('chatArea').addEventListener('click', (e) => {
      const target = e.target.closest('.chat-image');
      if (!target) return;
      const src = target.getAttribute('data-src') || target.src;
      img.src = src;
      viewer.classList.remove('hide');
      viewer.style.display = 'flex';
    });

    const closeViewer = () => {
      viewer.classList.add('hide');
      setTimeout(() => { viewer.style.display = 'none'; }, 300);
    };
    bg.addEventListener('click', closeViewer);
    closeBtn.addEventListener('click', closeViewer);
  }

  /** 初始化微信二维码弹窗 */
  function initWechat() {
    const btn = document.getElementById('wechatBtn');
    const overlay = document.getElementById('wechatOverlay');
    const bg = document.getElementById('wechatBg');
    const closeBtn = document.getElementById('wechatClose');

    if (!btn) return;

    const open = () => {
      overlay.classList.remove('hide');
      overlay.style.display = 'flex';
    };
    const close = () => {
      overlay.classList.add('hide');
      setTimeout(() => { overlay.style.display = 'none'; }, 300);
    };

    btn.addEventListener('click', open);
    bg.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
  }

  // DOM Ready 后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
