// JD 匹配助手 - 后台服务（service worker）
// 1. 转发 DeepSeek API（借助 host_permissions 绕过 CORS）
// 2. 截图框选分析：事件驱动全链路在后台执行，不依赖 popup 保持打开

importScripts('shared.js');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'callDeepSeek') {
    handleApiMessage(msg.payload)
      .then((content) => sendResponse({ content }))
      .catch((err) => sendResponse({ error: (err && err.message) ? err.message : String(err) }));
    return true;
  }

  if (msg && msg.type === 'startShotAnalysis') {
    startShotAnalysis()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }
});

// 页面覆盖层回传框选结果（含 dpr）。事件驱动，收到后异步继续，不阻塞响应。
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'shotRect' && sender.tab) {
    const payload = {
      rect: msg.rect,
      dpr: msg.dpr || 1,
      vw: msg.vw,
      vh: msg.vh,
      tabId: sender.tab.id,
    };
    if (!msg.rect) {
      setShotStatus('canceled', '已取消框选');
      return;
    }
    // 不 await：service worker 靠该异步任务与其中的 fetch 保活
    continueShotAnalysis(payload).catch((err) => {
      setShotStatus('error', friendlyError(err), { error: friendlyError(err) });
    });
  }
});

// ===== 启动截图：校验 + 注入覆盖层，立即返回 =====
async function startShotAnalysis() {
  const data = await chrome.storage.local.get([STORAGE_KEY.apiKey, STORAGE_KEY.profile]);
  if (!data[STORAGE_KEY.apiKey]) throw new Error('请先在「简历」页填写 API Key');
  if (!data[STORAGE_KEY.profile]) throw new Error('请先在「简历」页生成简历画像');

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error('未找到当前标签页');
  if (tab.url && /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)) {
    throw new Error('无法在浏览器内部页面使用，请打开普通的 JD 网页');
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectOverlay,
  });
  await setShotStatus('selecting', '请在页面上拖拽框选 JD 区域');
  return { started: true, tabId: tab.id };
}

// 框选完成后的全链路：截图 → 裁剪 → 识别 → 匹配 → 存结果
async function continueShotAnalysis(shot) {
  // 重新从 storage 读取，避免 service worker 被重启后内存状态丢失
  const data = await chrome.storage.local.get([STORAGE_KEY.apiKey, STORAGE_KEY.profile]);
  const apiKey = data[STORAGE_KEY.apiKey];
  const profile = data[STORAGE_KEY.profile];
  if (!apiKey) throw new Error('API Key 缺失，请重新保存');
  if (!profile) throw new Error('简历画像缺失，请重新生成');

  const tab = await chrome.tabs.get(shot.tabId);

  await setShotStatus('capturing', '正在截取当前页面…');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (!dataUrl) throw new Error('截图失败，请重试');

  const cropped = await cropWithOffscreen(dataUrl, shot);

  await setShotStatus('recognizing', '正在识别截图中的岗位文字…');
  const jdText = await recognizeJDFromImage(cropped, apiKey);
  if (!jdText || jdText.trim().length < 20) {
    throw new Error('截图中未识别到足够的岗位文字，请重新框选包含 JD 正文的区域');
  }

  await setShotStatus('matching', '正在分析匹配度…');
  const jd = {
    title: tab.title || tab.url,
    url: tab.url,
    selected: '',
    text: jdText,
    profileSnapshot: profile,
  };
  const match = await runMatchInBackground(profile, jd, apiKey);

  const history = await addHistory(match, jd);
  await setShotStatus('done', '分析完成', { match, jd });
  return { match, history };
}

// ===== OffscreenCanvas 裁剪（service worker 无 DOM Image） =====
async function cropWithOffscreen(dataUrl, shot) {
  const blob = await (await fetch(dataUrl)).blob();
  const full = await createImageBitmap(blob);
  const dpr = shot.dpr || 1;
  const sw = Math.max(1, Math.round(shot.rect.width * dpr));
  const sh = Math.max(1, Math.round(shot.rect.height * dpr));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    full,
    shot.rect.x * dpr, shot.rect.y * dpr, sw, sh,
    0, 0, sw, sh
  );
  full.close();

  const out = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataURL(out);
}

async function blobToDataURL(blob) {
  const buf = await blob.arrayBuffer();
  return `data:${blob.type};base64,${arrayBufferToBase64(buf)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ===== 视觉识别 =====
async function recognizeJDFromImage(dataUrl, apiKey) {
  const content = await callDeepSeek({
    apiKey,
    messages: [
      {
        role: 'system',
        content: '你是岗位 JD 识别助手。请从用户提供的截图中完整提取岗位描述文字，包含职位名称、岗位职责、任职要求、技术栈等。只输出提取到的纯文本，按原有条目换行，不要解释，不要补充截图中没有的内容；识别不清的地方省略即可。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请提取这张招聘页面截图中的岗位 JD 正文：' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
    temperature: 0.1,
    maxTokens: 4000,
  });
  return String(content || '').trim();
}

// ===== 匹配分析 =====
async function runMatchInBackground(profile, jd, apiKey) {
  const content = await callDeepSeek({
    apiKey,
    messages: [
      { role: 'system', content: MATCH_SYSTEM_PROMPT },
      { role: 'user', content: buildMatchUserMessage(profile, jd.text) },
    ],
    jsonMode: true,
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
  });
  return normalizeMatch(parseJSON(content));
}

// ===== 截图任务状态 =====
async function setShotStatus(phase, message, extra = {}) {
  const status = { phase, message, updatedAt: Date.now(), ...extra };
  await chrome.storage.local.set({ [STORAGE_KEY.shotStatus]: status });
  return status;
}

// ===== 页面覆盖层（注入到 content） =====
function injectOverlay() {
  if (document.getElementById('__jd-shot-overlay__')) return;
  const overlay = document.createElement('div');
  overlay.id = '__jd-shot-overlay__';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.35);cursor:crosshair;';
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;border:1px dashed #4f46e5;background:rgba(79,70,229,0.15);display:none;';
  const tip = document.createElement('div');
  tip.textContent = '拖拽框选 JD 区域，松开确认；按 Esc 取消';
  tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:2147483648;';
  overlay.appendChild(box);
  overlay.appendChild(tip);
  document.body.appendChild(overlay);

  let startX = 0, startY = 0, selecting = false;

  const cleanup = () => overlay.remove();
  const sendRect = (rect) => {
    chrome.runtime.sendMessage({
      type: 'shotRect',
      rect,
      dpr: window.devicePixelRatio || 1,
      vw: window.innerWidth,
      vh: window.innerHeight,
    });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { cleanup(); sendRect(null); }
  };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', (e) => {
    selecting = true;
    startX = e.clientX; startY = e.clientY;
    box.style.display = 'block';
    box.style.left = startX + 'px';
    box.style.top = startY + 'px';
    box.style.width = '0px';
    box.style.height = '0px';
  });
  overlay.addEventListener('mousemove', (e) => {
    if (!selecting) return;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.width = w + 'px'; box.style.height = h + 'px';
  });
  overlay.addEventListener('mouseup', (e) => {
    selecting = false;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    cleanup();
    const rect = (w >= 20 && h >= 20) ? { x, y, width: w, height: h } : null;
    sendRect(rect);
  });
}

// ===== DeepSeek API 调用，返回 content 字符串 =====
async function handleApiMessage(payload) {
  if (!payload.apiKey) {
    const d = await chrome.storage.local.get(STORAGE_KEY.apiKey);
    payload.apiKey = d[STORAGE_KEY.apiKey];
  }
  return callDeepSeek(payload);
}

async function callDeepSeek({ apiKey, messages, jsonMode = false, temperature = 0.3, maxTokens = 2000, model }) {
  if (!apiKey) throw new Error('请先填写 DeepSeek API Key');

  const body = {
    model: model || MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && j.error && j.error.message) || JSON.stringify(j);
    } catch (_) {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`DeepSeek API 错误 (${res.status})：${detail}`);
  }

  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('DeepSeek 返回内容为空');
  return content;
}
