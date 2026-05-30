import http from 'node:http';
import { URL } from 'node:url';
import { ProxyAgent } from 'undici';
import { createServer as createViteServer } from 'vite';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5173);
const INTERNAL_BASE_URL = process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${PORT}`;
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 2 * 1024 * 1024);
const MAX_SCREENSHOT_VIEWPORT_HEIGHT = Number(process.env.MAX_SCREENSHOT_VIEWPORT_HEIGHT || 30000);
const SHARE_PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';

const vite = await createViteServer({
  appType: 'spa',
  server: {
    host: HOST,
    middlewareMode: true
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (requestUrl.pathname === '/api/import-share' || requestUrl.pathname === '/api/import-chatgpt') {
      await handleShareImport(requestUrl, res);
      return;
    }

    if (requestUrl.pathname === '/api/render-image') {
      await handleRenderImage(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/render-json') {
      await handleRenderJson(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === '/api/image-placeholder') {
      handleImagePlaceholder(requestUrl, res);
      return;
    }

    vite.middlewares(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : '导入失败'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI 回复转图片工具已启动：http://${HOST}:${PORT}/`);
});

async function handleShareImport(requestUrl, res) {
  const shareUrl = requestUrl.searchParams.get('url') || '';
  const { url, provider } = validateShareUrl(shareUrl);
  const parsed = provider === 'gemini' ? await parseGeminiShare(url) : await importChatGptShare(url);

  if (!parsed.messages.length) {
    sendJson(res, 422, {
      error: '没有从这个分享页里识别到可整理的对话内容'
    });
    return;
  }

  sendJson(res, 200, {
    title: parsed.title,
    source: provider === 'gemini' ? 'Gemini 分享链接' : 'ChatGPT 分享链接',
    messageCount: parsed.messages.length,
    imageCount: countImages(parsed.messages),
    unavailableImageCount: countUnavailableImages(parsed.messages),
    markdown: buildMarkdown(parsed)
  });
}

async function handleRenderImage(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '请使用 POST 请求生成图片' });
    return;
  }

  const payload = await readJsonBody(req);
  const renderPayload = await buildRenderPayload(payload);
  const image = await renderCardToPng(renderPayload);

  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'x-render-title': encodeURIComponent(renderPayload.title),
    'x-render-source': encodeURIComponent(renderPayload.source)
  });
  res.end(image);
}

async function handleRenderJson(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '请使用 POST 请求生成图片' });
    return;
  }

  const payload = await readJsonBody(req);
  const renderPayload = await buildRenderPayload(payload);
  const image = await renderCardToPng(renderPayload);

  sendJson(res, 200, {
    title: renderPayload.title,
    source: renderPayload.source,
    filename: `${safeFileName(renderPayload.title)}.png`,
    mimeType: 'image/png',
    imageBase64: image.toString('base64')
  });
}

async function buildRenderPayload(payload) {
  const text = String(payload.text || '').trim();
  const shareUrl = String(payload.shareUrl || '').trim() || extractSupportedShareUrl(text);

  if (shareUrl) {
    const { url, provider } = validateShareUrl(shareUrl);
    const parsed = provider === 'gemini' ? await parseGeminiShare(url) : await importChatGptShare(url);
    const source = provider === 'gemini' ? 'Gemini 分享链接' : 'ChatGPT 分享链接';

    return normalizeRenderPayload({
      ...payload,
      markdown: buildMarkdown(parsed),
      title: parsed.title || '分享整理',
      source,
      shareUrl: url
    });
  }

  const markdown = String(payload.markdown || payload.text || '').trim();
  if (!markdown) {
    throw new Error('请发送 Markdown 内容，或 ChatGPT/Gemini 分享链接');
  }

  return normalizeRenderPayload({
    ...payload,
    markdown,
    title: String(payload.title || '').trim() || extractMarkdownTitle(markdown) || 'AI 回复整理',
    source: String(payload.source || '').trim() || 'Hermes'
  });
}

function normalizeRenderPayload(payload) {
  const width = clampNumber(Number(payload.width || 720), 640, 860);
  const fontSize = clampNumber(Number(payload.fontSize || 18), 15, 24);
  const lineHeight = clampNumber(Number(payload.lineHeight || 1.72), 1.45, 2);
  const theme = ['paper', 'ink', 'wechat', 'warm'].includes(payload.theme) ? payload.theme : 'paper';

  return {
    markdown: normalizeMarkdownForReading(payload.markdown || ''),
    title: String(payload.title || 'AI 回复整理'),
    source: String(payload.source || 'Hermes'),
    shareUrl: String(payload.shareUrl || ''),
    theme,
    width: String(width),
    fontSize,
    lineHeight,
    showMeta: payload.showMeta !== false
  };
}

function normalizeMarkdownForReading(markdown) {
  return String(markdown || '')
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) => {
      if (part.startsWith('```') || part.startsWith('~~~')) {
        return part;
      }

      return part
        .replace(/\\\*\\\*/g, '**')
        .replace(/\\_\\_/g, '__')
        .replace(/\*\*[\t \u00a0\u3000]+(?=\S)/g, '**')
        .replace(/([^\s*])[\t \u00a0\u3000]+\*\*/g, '$1**')
        .replace(/\*\*([“"「『《（【])([^*\n]+?)([”"」』》）】])\*\*/g, '$1**$2**$3')
        .replace(/__([“"「『《（【])([^_\n]+?)([”"」』》）】])__/g, '$1__$2__$3')
        .replace(/__[\t \u00a0\u3000]+(?=\S)/g, '__')
        .replace(/([^\s_])[\t \u00a0\u3000]+__/g, '$1__')
        .replace(/(!?\[[^\]\n]+\])[\t \u00a0\u3000]+\(/g, '$1(');
    })
    .join('');
}

async function renderCardToPng(renderPayload) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'zh-CN'
  });

  try {
    await context.addInitScript((payload) => {
      localStorage.setItem('share-tool:markdown', payload.markdown);
      localStorage.setItem('share-tool:title', payload.title);
      localStorage.setItem('share-tool:source', payload.source);
      localStorage.setItem('share-tool:shareUrl', payload.shareUrl);
      localStorage.setItem('share-tool:theme', payload.theme);
      localStorage.setItem('share-tool:width', payload.width);
      localStorage.setItem('share-tool:fontSize', String(payload.fontSize));
      localStorage.setItem('share-tool:lineHeight', String(payload.lineHeight));
      localStorage.setItem('share-tool:showMeta', String(payload.showMeta));
    }, renderPayload);

    const page = await context.newPage();
    await page.goto(`${INTERNAL_BASE_URL}/?capture=1`, { waitUntil: 'networkidle' });
    await page.locator('#shareCard').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts?.ready);

    const metrics = await page.locator('#shareCard').evaluate((element) => ({
      width: Math.ceil(Math.max(element.scrollWidth, element.getBoundingClientRect().width)),
      height: Math.ceil(Math.max(element.scrollHeight, element.getBoundingClientRect().height))
    }));

    await page.setViewportSize({
      width: Math.max(metrics.width + 8, 640),
      height: Math.min(Math.max(metrics.height + 8, 900), MAX_SCREENSHOT_VIEWPORT_HEIGHT)
    });

    return await page.locator('#shareCard').screenshot({
      type: 'png',
      animations: 'disabled'
    });
  } finally {
    await context.close();
  }
}

let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import('playwright')
      .then(({ chromium }) =>
        chromium.launch({
          headless: true,
          channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
          executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
          args: ['--no-sandbox', '--disable-dev-shm-usage']
        })
      )
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  return browserPromise;
}

async function importChatGptShare(shareUrl) {
  const response = await shareFetch(shareUrl, {
    headers: defaultShareHeaders(),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`分享页读取失败：HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseChatGptShare(html, shareUrl);
}

function validateShareUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error('请输入完整的分享链接');
  }

  const provider = detectShareProvider(parsed);
  if (!provider) {
    throw new Error('目前支持 ChatGPT 和 Gemini 的公开分享链接');
  }

  if (!parsed.pathname.startsWith('/share/')) {
    throw new Error('链接格式不对，需要是 /share/ 开头的公开分享链接');
  }

  return {
    provider,
    url: parsed.toString()
  };
}

function detectShareProvider(parsed) {
  const chatGptHosts = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
  const geminiHosts = new Set(['gemini.google.com']);

  if (chatGptHosts.has(parsed.hostname)) {
    return 'chatgpt';
  }

  if (geminiHosts.has(parsed.hostname)) {
    return 'gemini';
  }

  return '';
}

function extractSupportedShareUrl(text) {
  const match = String(text).match(
    /https?:\/\/(?:www\.)?(?:chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\/share\/[^\s<>"']+/i
  );

  if (!match) {
    return '';
  }

  return match[0].replace(/[),，。.!！?？]+$/g, '');
}

function defaultShareHeaders(extra = {}) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    ...extra
  };
}

function parseChatGptShare(html, shareUrl) {
  const title = extractTitle(html);
  const fullConversation = parseSharedConversationPayload(html);

  if (fullConversation.messages.length) {
    return {
      shareUrl,
      title: fullConversation.title || title,
      messages: fullConversation.messages
    };
  }

  const messages = [];
  const assistantPattern =
    /content_type\\",\\"text\\",\\"parts\\",\[\d+\],\\"((?:\\\\.|[^\\"])*)\\",\\"role\\",\\"assistant\\"/g;
  const userPattern =
    /message_source\\",\[\d+\],\\"((?:\\\\.|[^\\"])*)\\",\\"user\\",\{\}/g;

  collectMatches(html, userPattern, 'user', messages);
  collectMatches(html, assistantPattern, 'assistant', messages);

  return {
    shareUrl,
    title,
    messages: messages
      .sort((a, b) => (a.timestamp ?? a.index) - (b.timestamp ?? b.index))
      .map(({ role, text }) => ({
        role,
        text: cleanMessage(text)
      }))
      .filter((message) => message.text)
  };
}

async function parseGeminiShare(shareUrl) {
  const shareId = extractGeminiShareId(shareUrl);
  const rpcText = await fetchGeminiShareRpc(shareUrl, shareId);
  const payload = parseBatchedRpcPayload(rpcText, 'ujx1Bf');
  const parsed = parseGeminiConversationPayload(payload, shareUrl);

  return {
    shareUrl,
    title: parsed.title,
    messages: parsed.messages
  };
}

function extractGeminiShareId(shareUrl) {
  const pathname = new URL(shareUrl).pathname;
  const match = pathname.match(/^\/share\/([^/?#]+)/);

  if (!match) {
    throw new Error('Gemini 链接格式不对，需要是 /share/ 开头的公开分享链接');
  }

  return match[1];
}

async function fetchGeminiShareRpc(shareUrl, shareId) {
  const endpoint = new URL('https://gemini.google.com/_/BardChatUi/data/batchexecute');
  endpoint.search = new URLSearchParams({
    rpcids: 'ujx1Bf',
    'source-path': `/share/${shareId}`,
    hl: 'zh-CN',
    _reqid: '1000',
    rt: 'c'
  }).toString();

  const requestBody = new URLSearchParams({
    'f.req': JSON.stringify([[['ujx1Bf', JSON.stringify([null, shareId, [4]]), null, 'generic']]])
  });

  const response = await shareFetch(endpoint, {
    method: 'POST',
    headers: defaultShareHeaders({
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      origin: 'https://gemini.google.com',
      referer: shareUrl
    }),
    body: requestBody
  });

  if (!response.ok) {
    throw new Error(`Gemini 分享页读取失败：HTTP ${response.status}`);
  }

  return response.text();
}

let proxyAgent;

function getShareFetchOptions(options = {}) {
  if (!SHARE_PROXY_URL) {
    return options;
  }

  proxyAgent ??= new ProxyAgent(SHARE_PROXY_URL);
  return {
    ...options,
    dispatcher: proxyAgent
  };
}

function shareFetch(url, options = {}) {
  return fetch(url, getShareFetchOptions(options));
}

function parseBatchedRpcPayload(text, rpcId) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== ")]}'");

  for (const line of lines) {
    if (!line.startsWith('[[')) {
      continue;
    }

    let batch;
    try {
      batch = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = batch.find((item) => item?.[0] === 'wrb.fr' && item?.[1] === rpcId);
    if (typeof entry?.[2] === 'string') {
      return JSON.parse(entry[2]);
    }
  }

  throw new Error('没有从 Gemini 分享页里识别到可整理的对话内容');
}

function parseGeminiConversationPayload(payload, shareUrl) {
  const conversation = payload?.[0] || [];
  const turns = Array.isArray(conversation?.[1]) ? conversation[1] : [];
  const title = cleanMessage(conversation?.[2]?.[1] || '') || 'Gemini 分享整理';
  const messages = [];

  for (const turn of turns) {
    const userText = cleanMessage(extractGeminiUserText(turn));
    const assistantText = cleanMessage(extractGeminiAssistantText(turn));
    const images = extractGeminiImages(turn);

    if (userText) {
      messages.push({
        role: 'user',
        text: userText,
        images: []
      });
    }

    if (assistantText || images.length) {
      messages.push({
        role: 'assistant',
        text: assistantText,
        images
      });
    }
  }

  return {
    shareUrl,
    title,
    messages
  };
}

function extractGeminiUserText(turn) {
  const prompt = turn?.[2]?.[0]?.[0];
  return typeof prompt === 'string' ? prompt : '';
}

function extractGeminiAssistantText(turn) {
  const candidates = turn?.[3]?.[0];

  if (!Array.isArray(candidates)) {
    return '';
  }

  for (const candidate of candidates) {
    const parts = candidate?.[1];
    if (Array.isArray(parts)) {
      const text = parts.filter((part) => typeof part === 'string').join('\n\n');
      if (text.trim()) {
        return text;
      }
    }
  }

  return '';
}

function extractGeminiImages(turn) {
  const urls = new Set();
  collectNestedStrings(turn?.[3], (value) => {
    if (isLikelyGeminiImageUrl(value)) {
      urls.add(value);
    }
  });

  return [...urls].map((url, index) => ({
    title: `Gemini 图片 ${index + 1}`,
    label: 'Gemini 图片',
    pointer: url,
    url,
    fileId: '',
    width: 0,
    height: 0,
    mimeType: '',
    isGenerated: false
  }));
}

function collectNestedStrings(value, callback) {
  if (typeof value === 'string') {
    callback(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedStrings(item, callback);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectNestedStrings(item, callback);
    }
  }
}

function isLikelyGeminiImageUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    const isHttp = ['http:', 'https:'].includes(url.protocol);
    const isImagePath = /\.(png|jpe?g|webp|gif)(?:$|[?#])/i.test(url.pathname);
    const isGoogleImageHost = /(^|\.)googleusercontent\.com$/i.test(url.hostname);
    const isBrandAsset =
      url.hostname === 'www.gstatic.com' &&
      (/\/images\/branding\/productlogos\//.test(url.pathname) ||
        /\/lamda\/images\/gemini/i.test(url.pathname));

    return isHttp && !isBrandAsset && (isImagePath || isGoogleImageHost);
  } catch {
    return false;
  }
}

function parseSharedConversationPayload(html) {
  const payload = extractReactRouterPayload(html);

  if (!payload) {
    return {
      title: '',
      messages: []
    };
  }

  try {
    const decoded = decodeReactRouterPayload(payload);
    const routeData = decoded?.loaderData?.['routes/share.$shareId.($action)'];
    const conversation = routeData?.serverResponse?.data;
    const nodes = Array.isArray(conversation?.linear_conversation)
      ? conversation.linear_conversation
      : [];

    return {
      title: typeof conversation?.title === 'string' ? conversation.title : '',
      messages: nodes
        .map((node) => node?.message)
        .filter(isReadableConversationMessage)
        .map((message) => ({
          role: message.author.role === 'tool' ? 'assistant' : message.author.role,
          text: cleanMessage(extractConversationText(message)),
          images: extractConversationImages(message)
        }))
        .filter((message) => message.text || message.images.length)
    };
  } catch {
    return {
      title: '',
      messages: []
    };
  }
}

function extractReactRouterPayload(html) {
  const enqueuePattern = /streamController\.enqueue\("((?:\\.|[^"\\])*)"\)/g;

  for (const match of html.matchAll(enqueuePattern)) {
    const chunk = JSON.parse(`"${match[1]}"`).trim();
    if (chunk.startsWith('[{')) {
      return JSON.parse(chunk);
    }
  }

  return null;
}

function decodeReactRouterPayload(values) {
  const memo = new Map();

  function resolveReference(value) {
    if (Number.isInteger(value)) {
      if (value < 0) {
        return undefined;
      }
      return decodeAt(value);
    }

    return value;
  }

  function decodeAt(index) {
    if (memo.has(index)) {
      return memo.get(index);
    }

    const value = values[index];

    if (Array.isArray(value)) {
      const decoded = [];
      memo.set(index, decoded);
      for (const item of value) {
        decoded.push(resolveReference(item));
      }
      return decoded;
    }

    if (value && typeof value === 'object') {
      const decoded = {};
      memo.set(index, decoded);
      for (const [key, item] of Object.entries(value)) {
        const decodedKey = key.startsWith('_') ? decodeAt(Number(key.slice(1))) : key;
        decoded[decodedKey] = resolveReference(item);
      }
      return decoded;
    }

    return value;
  }

  return decodeAt(0);
}

function isReadableConversationMessage(message) {
  const role = message?.author?.role;
  const metadata = message?.metadata || {};
  const text = extractConversationText(message);
  const images = extractConversationImages(message);

  if (!['user', 'assistant', 'tool'].includes(role)) {
    return false;
  }

  if ((!text && !images.length) || text === 'The output of this plugin was redacted.') {
    return false;
  }

  if (role === 'tool' && !images.length) {
    return false;
  }

  if (
    metadata.is_visually_hidden_from_conversation ||
    metadata.is_user_system_message ||
    metadata.is_redacted ||
    metadata.is_thinking_preamble_message
  ) {
    return false;
  }

  return message.status === 'finished_successfully';
}

function extractConversationText(message) {
  const content = message?.content || {};

  if (content.content_type === 'text') {
    return Array.isArray(content.parts)
      ? content.parts.filter((part) => typeof part === 'string').join('\n\n')
      : '';
  }

  if (content.content_type === 'multimodal_text') {
    return Array.isArray(content.parts)
      ? content.parts
          .map((part) => {
            if (typeof part === 'string') {
              return part;
            }
            return typeof part?.text === 'string' ? part.text : '';
          })
          .filter(Boolean)
          .join('\n\n')
      : '';
  }

  return '';
}

function extractConversationImages(message) {
  const content = message?.content || {};
  const metadata = message?.metadata || {};
  const images = [];
  const title = metadata.image_gen_title || '图片';

  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (part?.content_type === 'image_asset_pointer') {
        images.push(normalizeImagePart(part, title));
      }
    }
  }

  if (Array.isArray(metadata.content_references)) {
    for (const reference of metadata.content_references) {
      if (reference?.type === 'image' || reference?.image_asset_pointer) {
        images.push(normalizeImagePart(reference.image_asset_pointer || reference, title));
      }
    }
  }

  return images.filter(Boolean);
}

function normalizeImagePart(part, fallbackTitle) {
  const pointer = part.asset_pointer || part.url || part.sediment_id || '';
  const fileId = extractFileId(pointer);
  const width = Number(part.width || part.width_px || 0);
  const height = Number(part.height || part.height_px || 0);
  const label = part.metadata?.dalle ? fallbackTitle : '图片';
  const title = part.metadata?.dalle ? fallbackTitle : part.name || fallbackTitle;

  if (!pointer && !fileId) {
    return null;
  }

  return {
    title,
    label,
    pointer,
    url: extractPublicImageUrl(part),
    fileId,
    width,
    height,
    mimeType: part.mime_type || '',
    isGenerated: Boolean(part.metadata?.dalle)
  };
}

function extractFileId(pointer) {
  const match = String(pointer).match(/file_[a-zA-Z0-9]+/);
  return match ? match[0] : '';
}

function extractPublicImageUrl(part) {
  const candidates = [
    part.url,
    part.image_url,
    part.content_url,
    part.thumbnail_url,
    part.encodings?.source?.path,
    part.encodings?.thumbnail?.path
  ];

  return candidates.find((candidate) => isPublicImageUrl(candidate)) || '';
}

function isPublicImageUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function collectMatches(html, pattern, role, messages) {
  for (const match of html.matchAll(pattern)) {
    const text = decodeStreamString(match[1]);
    const start = match.index || 0;
    const end = start + match[0].length;
    const timestamp = extractTimestamp(html, start, end, role);
    messages.push({
      index: start,
      timestamp,
      role,
      text
    });
  }
}

function extractTimestamp(html, start, end, role) {
  if (role === 'user') {
    const before = html.slice(Math.max(0, start - 1200), start).match(/\d{10}\.\d+/g);
    if (!before?.length) {
      return null;
    }

    const createdAt = before.length >= 2 ? before[before.length - 2] : before[before.length - 1];
    return Number(createdAt);
  }

  const after = html.slice(end, end + 1200).match(/\d{10}\.\d+/);
  return after ? Number(after[0]) : null;
}

function extractTitle(html) {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const rawTitle = titleMatch ? decodeHtml(titleMatch[1]) : 'ChatGPT 分享整理';
  return rawTitle.replace(/^ChatGPT\s*-\s*/i, '').trim() || 'ChatGPT 分享整理';
}

function decodeStreamString(value) {
  try {
    const decoded = JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
    if (decoded.includes('\\n') || decoded.includes('\\"')) {
      return JSON.parse(`"${decoded.replace(/"/g, '\\"')}"`);
    }
    return decoded;
  } catch {
    return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanMessage(value) {
  return value
    .replace(/cite[^]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMarkdownTitle(markdown) {
  const heading = String(markdown).match(/^#\s+(.+)$/m);
  if (heading?.[1]) {
    return heading[1].trim().slice(0, 80);
  }

  const firstLine = String(markdown)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('```'));

  return firstLine ? stripMarkdown(firstLine).slice(0, 40) : '';
}

function stripMarkdown(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[#>*\-\d.\s]+/, '')
    .replace(/[`*_~]/g, '')
    .trim();
}

function safeFileName(value) {
  return (
    String(value || 'ai-response-image')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'ai-response-image'
  );
}

function buildMarkdown({ title, shareUrl, messages }) {
  const chunks = [`> 原链接：${shareUrl}`];
  let turn = 1;

  for (const message of messages) {
    const heading = message.role === 'user' ? `## 提问 ${turn}` : `## 回复 ${turn}`;
    const body = [renderImages(message.images || []), message.text].filter(Boolean).join('\n\n');
    chunks.push(`${heading}\n\n${body}`);

    if (message.role === 'assistant') {
      turn += 1;
    }
  }

  return `${chunks.join('\n\n')}\n`;
}

function renderImages(images) {
  return images
    .map((image, index) => {
      const title = image.title || image.label || `图片 ${index + 1}`;

      if (image.url) {
        return `![${title}](${image.url})`;
      }

      return renderUnavailableImageCard(image, index);
    })
    .join('\n\n');
}

function renderUnavailableImageCard(image, index) {
  const title = image.title || image.label || `图片 ${index + 1}`;
  const label = image.isGenerated ? 'ChatGPT 生成图片' : '对话图片';
  const details = [image.fileId, image.width && image.height ? `${image.width} x ${image.height}` : '']
    .filter(Boolean)
    .join(' | ');

  return `<figure class="chatgpt-missing-image">
  <div class="chatgpt-missing-image__badge">${escapeHtml(label)}</div>
  <figcaption>
    <strong>${escapeHtml(title)}</strong>
    <span>ChatGPT 公开分享页没有开放这张图片的原图地址，当前只能保留图片位置和信息。</span>
    ${details ? `<small>${escapeHtml(details)}</small>` : ''}
  </figcaption>
</figure>`;
}

function countImages(messages) {
  return messages.reduce((total, message) => total + (message.images?.length || 0), 0);
}

function countUnavailableImages(messages) {
  return messages.reduce(
    (total, message) => total + (message.images || []).filter((image) => !image.url).length,
    0
  );
}

function handleImagePlaceholder(requestUrl, res) {
  const title = requestUrl.searchParams.get('title') || '图片';
  const label = requestUrl.searchParams.get('label') || '对话图片';
  const file = requestUrl.searchParams.get('file') || '';
  const width = Number(requestUrl.searchParams.get('width') || 1200);
  const height = Number(requestUrl.searchParams.get('height') || 760);
  const safeWidth = Math.min(Math.max(width || 1200, 640), 1400);
  const safeHeight = Math.min(Math.max(height || 760, 360), 1000);
  const details = [file, width && height ? `${width} x ${height}` : ''].filter(Boolean).join(' | ');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">
  <rect width="100%" height="100%" rx="24" fill="#f1f5f9"/>
  <rect x="28" y="28" width="${safeWidth - 56}" height="${safeHeight - 56}" rx="18" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>
  <circle cx="86" cy="84" r="26" fill="#166534"/>
  <path d="M76 86l8 8 14-18" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="130" y="78" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#1f2937">${escapeSvg(label)}</text>
  <text x="130" y="122" font-family="Arial, sans-serif" font-size="22" fill="#475569">${escapeSvg(title)}</text>
  <text x="130" y="164" font-family="Arial, sans-serif" font-size="18" fill="#64748b">${escapeSvg(details || '原图来自 ChatGPT 分享页内部资源')}</text>
  <text x="50%" y="${safeHeight - 54}" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" fill="#64748b">已保留图片位置；公开分享页未暴露可直接下载的原图地址</text>
</svg>`;

  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(svg);
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new Error('内容太长，超过当前服务的请求大小限制');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求内容不是有效的 JSON');
  }
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload));
}

async function closeBrowser() {
  if (!browserPromise) {
    return;
  }

  const browser = await browserPromise.catch(() => null);
  await browser?.close();
}

process.once('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});
