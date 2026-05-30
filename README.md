# Markdown 分享排版工具

把 Markdown 格式的 AI 回复转成适合微信阅读的长图或 PDF。

## 本地运行

```bash
npm install
npm run dev
```

打开终端显示的本地地址即可使用。

## 当前能力

- 粘贴 Markdown 后即时预览
- 支持导入公开的 ChatGPT、Gemini 分享链接
- 支持服务端生成 PNG，方便 Hermes 调用后发回 Telegram
- 支持识别分享链接里的图片，并在阅读版中保留图片位置
- 支持标题、来源、页眉开关
- 支持清爽白、深色、微信绿、暖灰主题
- 支持窄版、常规、宽版排版
- 支持字号和行距调整
- 支持导出 PNG、PDF，支持复制图片到剪贴板

## 分享链接导入

本地开发服务里带了一个 `/api/import-share` 接口，用来抓取公开分享页并整理成 Markdown。前端不能直接读取 `chatgpt.com`、`gemini.google.com` 页面，所以这一步需要本地服务配合。旧的 `/api/import-chatgpt` 仍然保留，避免之前的调用失效。

ChatGPT 分享页里的图片通常不是公开直链，而是内部 `sediment://file_...` 资源指针。当前版本会保留图片位置、标题、文件标识和尺寸；如果后续接入可用的登录态代理，可以再把占位图替换成原图。

Gemini 分享页的正文不在静态 HTML 里，当前版本会通过它公开页面使用的读取接口拿到对话正文，再转成同一套阅读版 Markdown。

## Hermes 调用

这个项目只做“渲染/解析服务”，不接管 Telegram Bot。你已有的 Hermes 收到 Telegram 消息后，调用这里的 HTTP 接口，再由 Hermes 把图片发回 Telegram。

### 接口

`POST /api/render-image`

请求 JSON：

```json
{
  "text": "Markdown 内容，或 ChatGPT/Gemini 分享链接"
}
```

返回：`image/png` 二进制图片。响应头里会带：

- `x-render-title`
- `x-render-source`

`POST /api/render-json`

请求 JSON 同上。返回 JSON，方便 Hermes 不好直接处理二进制响应时使用：

```json
{
  "title": "标题",
  "source": "来源",
  "filename": "标题.png",
  "mimeType": "image/png",
  "imageBase64": "..."
}
```

### Docker 部署

```bash
docker compose -f docker-compose.hermes.yml up -d --build
```

默认监听 `5173`，Hermes 可以从同一个 Docker 网络或 NAS 内网访问：

```text
http://hermes-markdown-render:5173/api/render-image
```

如果 Hermes 不在同一个 Docker 网络里，可以用 NAS 内网地址：

```text
http://NAS内网IP:5173/api/render-image
```

不需要 DDNS，也不需要把 NAS 暴露到公网。只有解析 ChatGPT/Gemini 分享链接时，运行这个服务的容器需要能访问 `chatgpt.com` / `gemini.google.com`。如果这些域名在 NAS 网络里不可达，需要让这个容器走 Hermes 已有的代理或可访问外网的出口。

本项目默认不在宿主机写运行文件；Docker 运行时的浏览器和 Node 依赖都在容器镜像内。

## 后续可接

- 部署到国内可访问的静态托管
- 增加二维码分享页
- 增加多套公众号/微信群阅读模板
