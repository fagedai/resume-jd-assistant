// JD 匹配助手 - 后台服务
// 负责调用 DeepSeek API。在 service worker 中发起请求可借助 host_permissions 绕过 CORS。

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'callDeepSeek') {
    callDeepSeek(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: (err && err.message) ? err.message : String(err) }));
    return true; // 保持通道开启以异步响应
  }
});

async function callDeepSeek({ apiKey, messages, jsonMode = false, temperature = 0.3, maxTokens = 2000 }) {
  if (!apiKey) throw new Error('请先填写 DeepSeek API Key');

  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

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
  return { content };
}
