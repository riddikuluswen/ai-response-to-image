import './styles.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const isCaptureMode = new URLSearchParams(window.location.search).get('capture') === '1';

if (isCaptureMode) {
  document.documentElement.dataset.capture = 'true';
}

const DEFAULT_MARKDOWN = `# 项目周会要点

本周重点放在需求确认、原型调整和上线准备。产品侧已经补齐主要使用场景，研发侧需要确认接口边界和异常处理。

## 已确认

- 登录流程保留手机号验证码
- 列表页增加状态筛选
- 导出文件命名规则统一

## 待处理

1. 周五前补一版移动端原型
2. 接口文档增加错误码说明
3. 测试环境准备一组完整数据

\`\`\`text
GET /api/projects?status=active
\`\`\`
`;

const state = {
  markdown: localStorage.getItem('share-tool:markdown') || DEFAULT_MARKDOWN,
  title: localStorage.getItem('share-tool:title') || 'AI 回复整理',
  source: localStorage.getItem('share-tool:source') || 'AI 回复转图片工具',
  shareUrl: localStorage.getItem('share-tool:shareUrl') || '',
  theme: localStorage.getItem('share-tool:theme') || 'paper',
  width: localStorage.getItem('share-tool:width') || '720',
  fontSize: Number(localStorage.getItem('share-tool:fontSize') || 18),
  lineHeight: Number(localStorage.getItem('share-tool:lineHeight') || 1.72),
  showMeta: localStorage.getItem('share-tool:showMeta') !== 'false'
};

marked.setOptions({
  breaks: true,
  gfm: true
});

const app = document.querySelector('#app');

app.innerHTML = `
  <main class="shell">
    <section class="editor-pane">
      <div class="topbar">
        <div>
          <h1>AI 回复转图片</h1>
        </div>
        <div class="quick-actions">
          <button class="ghost" id="pasteBtn" type="button">粘贴</button>
          <button class="ghost" id="clearBtn" type="button">清空</button>
        </div>
      </div>

      <label class="field compact">
        <span>标题</span>
        <input id="titleInput" type="text" autocomplete="off" />
      </label>

      <label class="field compact">
        <span>来源</span>
        <input id="sourceInput" type="text" autocomplete="off" />
      </label>

      <div class="import-panel">
        <label class="field compact import-field">
          <span>分享链接</span>
          <input id="shareUrlInput" type="url" autocomplete="off" placeholder="https://chatgpt.com/share/... 或 https://gemini.google.com/share/..." />
        </label>
        <button id="importShareBtn" type="button">导入链接</button>
      </div>

      <label class="field editor">
        <span>Markdown</span>
        <textarea id="markdownInput" spellcheck="false" placeholder="把 Markdown 粘贴到这里"></textarea>
      </label>
    </section>

    <section class="preview-pane">
      <div class="toolbar" aria-label="导出设置">
        <div class="control-group">
          <label>
            <span>主题</span>
            <select id="themeSelect">
              <option value="paper">清爽白</option>
              <option value="ink">深色</option>
              <option value="wechat">微信绿</option>
              <option value="warm">暖灰</option>
            </select>
          </label>

          <label>
            <span>宽度</span>
            <select id="widthSelect">
              <option value="640">窄版</option>
              <option value="720">常规</option>
              <option value="860">宽版</option>
            </select>
          </label>
        </div>

        <div class="control-group sliders">
          <label>
            <span>字号</span>
            <input id="fontSizeInput" type="range" min="15" max="24" step="1" />
          </label>
          <label>
            <span>行距</span>
            <input id="lineHeightInput" type="range" min="1.45" max="2" step="0.05" />
          </label>
          <label class="toggle">
            <input id="metaToggle" type="checkbox" />
            <span>显示页眉</span>
          </label>
        </div>

        <div class="export-actions">
          <button id="copyImageBtn" type="button">复制图片</button>
          <button id="pngBtn" type="button">导出 PNG</button>
          <button id="pdfBtn" type="button">导出 PDF</button>
        </div>
      </div>

      <div class="preview-stage">
        <article id="shareCard" class="share-card" aria-label="排版预览">
          <header id="cardMeta" class="card-meta">
            <p id="cardSource"></p>
            <time id="cardDate"></time>
          </header>
          <h2 id="cardTitle"></h2>
          <div id="renderedContent" class="rendered"></div>
        </article>
      </div>
    </section>
  </main>

  <div id="toast" role="status" aria-live="polite"></div>
`;

const nodes = {
  markdownInput: document.querySelector('#markdownInput'),
  titleInput: document.querySelector('#titleInput'),
  sourceInput: document.querySelector('#sourceInput'),
  shareUrlInput: document.querySelector('#shareUrlInput'),
  themeSelect: document.querySelector('#themeSelect'),
  widthSelect: document.querySelector('#widthSelect'),
  fontSizeInput: document.querySelector('#fontSizeInput'),
  lineHeightInput: document.querySelector('#lineHeightInput'),
  metaToggle: document.querySelector('#metaToggle'),
  shareCard: document.querySelector('#shareCard'),
  cardMeta: document.querySelector('#cardMeta'),
  cardTitle: document.querySelector('#cardTitle'),
  cardSource: document.querySelector('#cardSource'),
  cardDate: document.querySelector('#cardDate'),
  renderedContent: document.querySelector('#renderedContent'),
  pasteBtn: document.querySelector('#pasteBtn'),
  clearBtn: document.querySelector('#clearBtn'),
  importShareBtn: document.querySelector('#importShareBtn'),
  pngBtn: document.querySelector('#pngBtn'),
  pdfBtn: document.querySelector('#pdfBtn'),
  copyImageBtn: document.querySelector('#copyImageBtn'),
  toast: document.querySelector('#toast')
};

function init() {
  nodes.markdownInput.value = state.markdown;
  nodes.titleInput.value = state.title;
  nodes.sourceInput.value = state.source;
  nodes.shareUrlInput.value = state.shareUrl;
  nodes.themeSelect.value = state.theme;
  nodes.widthSelect.value = state.width;
  nodes.fontSizeInput.value = state.fontSize;
  nodes.lineHeightInput.value = state.lineHeight;
  nodes.metaToggle.checked = state.showMeta;

  bindEvents();
  render();
}

function bindEvents() {
  nodes.markdownInput.addEventListener('input', (event) => {
    state.markdown = event.target.value;
    save('markdown');
    render();
  });

  nodes.titleInput.addEventListener('input', (event) => {
    state.title = event.target.value;
    save('title');
    render();
  });

  nodes.sourceInput.addEventListener('input', (event) => {
    state.source = event.target.value;
    save('source');
    render();
  });

  nodes.shareUrlInput.addEventListener('input', (event) => {
    state.shareUrl = event.target.value;
    save('shareUrl');
  });

  nodes.themeSelect.addEventListener('change', (event) => {
    state.theme = event.target.value;
    save('theme');
    render();
  });

  nodes.widthSelect.addEventListener('change', (event) => {
    state.width = event.target.value;
    save('width');
    render();
  });

  nodes.fontSizeInput.addEventListener('input', (event) => {
    state.fontSize = Number(event.target.value);
    save('fontSize');
    render();
  });

  nodes.lineHeightInput.addEventListener('input', (event) => {
    state.lineHeight = Number(event.target.value);
    save('lineHeight');
    render();
  });

  nodes.metaToggle.addEventListener('change', (event) => {
    state.showMeta = event.target.checked;
    save('showMeta');
    render();
  });

  nodes.pasteBtn.addEventListener('click', pasteFromClipboard);
  nodes.clearBtn.addEventListener('click', clearMarkdown);
  nodes.importShareBtn.addEventListener('click', importShareLink);
  nodes.pngBtn.addEventListener('click', exportPng);
  nodes.pdfBtn.addEventListener('click', exportPdf);
  nodes.copyImageBtn.addEventListener('click', copyImage);
}

function render() {
  const unsafeHtml = marked.parse(normalizeMarkdownForReading(state.markdown || ''));
  nodes.renderedContent.innerHTML = DOMPurify.sanitize(unsafeHtml);
  nodes.cardTitle.textContent = state.title.trim() || '未命名内容';
  nodes.cardSource.textContent = state.source.trim() || 'AI 回复转图片工具';
  nodes.cardDate.textContent = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());

  nodes.cardMeta.hidden = !state.showMeta;
  nodes.shareCard.dataset.theme = state.theme;
  nodes.shareCard.style.setProperty('--card-width', `${state.width}px`);
  nodes.shareCard.style.setProperty('--reader-font-size', `${state.fontSize}px`);
  nodes.shareCard.style.setProperty('--reader-line-height', state.lineHeight);
  removeDuplicateTitleHeading();
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

function removeDuplicateTitleHeading() {
  const firstElement = nodes.renderedContent.firstElementChild;
  const title = state.title.trim();

  if (firstElement?.tagName === 'H1' && title && firstElement.textContent.trim() === title) {
    firstElement.remove();
  }
}

function save(key) {
  localStorage.setItem(`share-tool:${key}`, String(state[key]));
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast('剪贴板里没有可用文本');
      return;
    }
    state.markdown = text;
    nodes.markdownInput.value = text;
    save('markdown');
    render();
    showToast('已粘贴');
  } catch (error) {
    showToast('浏览器没有剪贴板权限');
  }
}

function clearMarkdown() {
  state.markdown = '';
  nodes.markdownInput.value = '';
  save('markdown');
  render();
}

async function importShareLink() {
  const url = nodes.shareUrlInput.value.trim();

  if (!url) {
    showToast('先粘贴分享链接');
    return;
  }

  nodes.importShareBtn.disabled = true;
  nodes.importShareBtn.textContent = '导入中';

  try {
    const response = await fetch(`/api/import-share?url=${encodeURIComponent(url)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '导入失败');
    }

    state.shareUrl = url;
    state.title = data.title || '分享整理';
    state.source = data.source || '分享链接';
    state.markdown = data.markdown || '';

    nodes.titleInput.value = state.title;
    nodes.sourceInput.value = state.source;
    nodes.markdownInput.value = state.markdown;

    save('shareUrl');
    save('title');
    save('source');
    save('markdown');
    render();
    const imageNote = data.unavailableImageCount
      ? `，${data.unavailableImageCount} 张图片仅保留说明`
      : '';
    showToast(`已导入 ${data.messageCount || 0} 条内容${imageNote}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导入失败');
  } finally {
    nodes.importShareBtn.disabled = false;
    nodes.importShareBtn.textContent = '导入链接';
  }
}

async function exportPng() {
  const canvas = await captureCard();
  downloadCanvasAsPng(canvas);
  showToast('PNG 已导出');
}

function downloadCanvasAsPng(canvas) {
  const link = document.createElement('a');
  link.download = `${safeFileName(state.title)}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

async function exportPdf() {
  const canvas = await captureCard();
  const imageData = canvas.toDataURL('image/png');
  const pdfWidth = 210;
  const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({
    orientation: pdfHeight > pdfWidth ? 'portrait' : 'landscape',
    unit: 'mm',
    format: [pdfWidth, pdfHeight]
  });

  pdf.addImage(imageData, 'PNG', 0, 0, pdfWidth, pdfHeight);
  pdf.save(`${safeFileName(state.title)}.pdf`);
  showToast('PDF 已导出');
}

async function copyImage() {
  if (!canWriteImageToClipboard()) {
    const canvas = await captureCard();
    downloadCanvasAsPng(canvas);
    showToast('当前地址不支持复制图片，已改为导出 PNG');
    return;
  }

  try {
    const canvas = await captureCard();
    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob
      })
    ]);
    showToast('图片已复制');
  } catch (error) {
    const canvas = await captureCard();
    downloadCanvasAsPng(canvas);
    showToast('复制被浏览器拦截，已改为导出 PNG');
  }
}

function canWriteImageToClipboard() {
  return Boolean(
    window.isSecureContext &&
      navigator.clipboard?.write &&
      window.ClipboardItem
  );
}

async function captureCard() {
  nodes.shareCard.classList.add('capturing');
  await document.fonts.ready;
  const { default: html2canvas } = await import('html2canvas');
  const canvas = await html2canvas(nodes.shareCard, {
    backgroundColor: null,
    scale: 2,
    useCORS: true,
    windowWidth: nodes.shareCard.scrollWidth,
    windowHeight: nodes.shareCard.scrollHeight
  });
  nodes.shareCard.classList.remove('capturing');
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('Canvas export failed'));
    }, 'image/png');
  });
}

function safeFileName(value) {
  return (value || 'ai-response-image')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'ai-response-image';
}

let toastTimer;

function showToast(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    nodes.toast.classList.remove('visible');
  }, 2200);
}

init();
