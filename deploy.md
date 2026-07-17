# 🚀 SS学长来帮你 - 部署指南

## 目录
1. [准备工作](#1-准备工作)
2. [方案A：后端 Railway + 前端 Netlify（推荐）](#方案a后端-railway--前端-netlify推荐)
3. [方案B：全栈 Cloudflare Workers + Pages](#方案b全栈-cloudflare-workers--pages)
4. [方案C：单服务器部署（最简单）](#方案c单服务器部署最简单)
5. [配置HTTPS与自定义域名](#5-配置https与自定义域名)
6. [短链接生成](#6-短链接生成)
7. [微信分享配置](#7-微信分享配置)
8. [常见问题](#8-常见问题)

---

## 1. 准备工作

### 需要注册的账号

| 服务 | 用途 | 费用 | 注册地址 |
|------|------|------|----------|
| **DeepSeek** | AI大模型 API | 充值制（注册送500万tokens） | https://platform.deepseek.com |
| **GitHub** | 代码托管 | 免费 | https://github.com |
| **Netlify**（前端） | H5页面托管 | 免费版够用 | https://netlify.com |
| **Railway**（后端） | API服务器托管 | 免费额度够用 | https://railway.app |
| **或 Render**（后端备选） | API服务器托管 | 免费额度够用 | https://render.com |

### 需要获取的密钥

1. **DeepSeek API Key**：在 DeepSeek 平台注册后，创建 API Key
2. **域名（可选）**：可以买一个便宜域名（如 `.xyz` 首年约 ¥10-20），也可以用 Netlify/Railway 提供的免费二级域名

### 本地开发环境

```bash
# 确保已安装 Node.js（推荐 v18+）
node -v

# 本项目的 Node 版本
# 项目使用 v22.22.2
```

---

## 方案A：后端 Railway + 前端 Netlify（推荐）

### 步骤1：在 GitHub 创建仓库

```bash
# 在项目根目录初始化 git
cd ss-helper
git init
git add .
git commit -m "init: SS学长来帮你校园AI助手"
```

然后去 GitHub 新建仓库，关联并推送。

### 步骤2：部署后端到 Railway

1. 注册 Railway 账号（用 GitHub 登录）
2. 点击 **New Project** → **Deploy from GitHub repo**
3. 选择你的仓库
4. 在 Railway 的 Dashboard 中设置环境变量：

   | 变量名 | 值 |
   |--------|-----|
   | `DEEPSEEK_API_KEY` | 你的 DeepSeek API Key |
   | `ADMIN_PASSWORD` | 你的管理后台密码 |
   | `PORT` | `3000`（Railway 自动映射） |

5. Railway 会自动检测 `package.json` 并执行 `npm start`
6. 部署完成后 Railway 会分配一个 `https://xxx.railway.app` 的域名

### 步骤3：部署前端到 Netlify

✅ **关键点：前端是静态文件，由后端托管，所以不需要单独部署前端。**

有两种方式：

**方式一（推荐）：直接通过 Railway 访问**
- Railway 部署完成后，直接访问 Railway 分配的 URL 即可打开前端页面
- 前端页面由 Express 的 `express.static('public')` 托管

**方式二：前端独立部署到 Netlify + 后端 API代理**

如果你想把前后端分离：

1. 在 Netlify 导入项目，指定 `public/` 为发布目录
2. 在 `public/` 目录下创建 `_redirects` 文件，内容：

```
/api/*  https://你的railway域名.railway.app/api/:splat  200
```

3. 这样前端页面由 Netlify 托管，API 请求自动转发到 Railway

### 步骤4：配置环境变量

本地开发时，复制 `.env.example` 为 `.env` 并填写：

```bash
cp .env.example .env
# 编辑 .env 文件填入你的 API Key
```

---

## 方案B：全栈 Cloudflare Workers + Pages

### 优点
- 免费额度非常充足
- 全球加速
- 自带 HTTPS

### 需要做的改造

Cloudflare Workers 运行在 Edge 环境，不支持 Node.js 原生模块（如 `fs`、`path`），需要做以下适配：

1. **向量存储改用 Cloudflare KV**
2. **文件上传改用 R2 对象存储**
3. **PDF解析等需用纯JS库**

如果你的用户量不大（校园场景），直接用方案A更省事。

---

## 方案C：单服务器部署（最简单）

如果你有一台云服务器（如腾讯云轻量服务器 ¥50/月），可以直接部署：

```bash
# 在服务器上
git clone 你的仓库
cd ss-helper

# 安装依赖
npm install

# 配置环境变量
nano .env
# 填入 DEEPSEEK_API_KEY 和 ADMIN_PASSWORD

# 使用 PM2 守护进程（推荐）
npm install -g pm2
pm2 start server.js --name ss-helper
pm2 save
pm2 startup

# 配置 Nginx 反向代理 + HTTPS（使用 certbot）
```

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name 你的域名.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name 你的域名.com;

    ssl_certificate /etc/letsencrypt/live/你的域名.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

---

## 5. 配置HTTPS与自定义域名

### 为什么需要 HTTPS？

微信内置浏览器**强制要求 HTTPS**，否则可能无法正常加载页面。

### 用 Cloudflare 免费搞定

1. 将域名 DNS 托管到 Cloudflare（免费）
2. Cloudflare 自动提供 SSL 证书（Flexible 模式即可）
3. 在 Cloudflare 的 SSL/TLS 设置中开启 "Always Use HTTPS"

### 绑定域名

以 Netlify 为例：
1. 在 Netlify 控制台 → Domain settings → Add custom domain
2. 在 Cloudflare 添加 CNAME 记录指向 Netlify 分配的域名

---

## 6. 短链接生成

方便在 QQ 群、微信群传播：

### 免费方案
- **Sina 短链接**：https://sina.lt （较稳定）
- **URL Shortener**：https://url.vc
- **自己搭建**：使用 yourls.org 在自己的服务器搭建

### 生成步骤
1. 拿到完整部署 URL
2. 进入短链接生成网站
3. 粘贴完整 URL → 生成短链接
4. 把短链接发到群里

---

## 7. 微信分享配置

### Open Graph 标签

`public/index.html` 中已包含：

```html
<meta property="og:title" content="SS学长来帮你 - 化院AI小助手">
<meta property="og:description" content="四川化工职业技术学院新生快问快答，像聊天一样获取校园信息！">
```

部署后替换 `og:image` 的链接为实际图片地址。

### 接入微信JS-SDK（可选）

如需在微信中分享时自定义标题和描述，需：

1. 在微信公众号后台配置 JS 安全域名
2. 后端增加 `wx.config` 签名接口
3. 前端调用 `wx.updateTimelineShareData` 和 `wx.updateAppMessageShareData`

一般来说，只设置 OG 标签就够用了。

---

## 8. 常见问题

### Q: 微信内打不开页面？
A: 检查是否配置了 HTTPS，微信强制要求 HTTPS。

### Q: 知识库检索不准确？
A: 确保文档内容清晰分段，避免大段无标点文本。可以上传更多详细文档提高检索质量。

### Q: DeepSeek API 调用失败？
A: 检查环境变量 `DEEPSEEK_API_KEY` 是否正确设置，以及账户余额是否充足。

### Q: 如何在本地测试？
```bash
cd ss-helper
cp .env.example .env   # 填写 API Key
npm install
npm start
# 打开 http://localhost:3000
```

### Q: 清除所有知识库数据？
```bash
# 停服务后删除 data/vector_store.json 文件
rm data/vector_store.json
# 重启服务后会自动重建
```

---

## 快速启动命令（开发环境）

```bash
# 1. 克隆项目
cd /path/to/your/project

# 2. 安装依赖
npm install

# 3. 配置环境变量
# 编辑 .env 文件，填入 DEEPSEEK_API_KEY

# 4. 启动
npm start

# 5. 打开浏览器访问
# http://localhost:3000
# 管理后台: http://localhost:3000/admin
```

---

## 推荐流程

```
Day 1: 注册 DeepSeek / GitHub / Railway / Netlify
Day 2: 配置 API Key，本地测试运行
Day 3: 上传至 GitHub，部署到 Railway
Day 4: 绑定域名，配置 HTTPS
Day 5: 录入知识库文档，测试问答效果
Day 6: 生成短链接，发到新生群！
```

**总花费预估：¥0（使用免费额度）～ ¥100（买域名+服务器）**

> 💡 有任何问题，直接问我就行！
