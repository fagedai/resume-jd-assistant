// JD 匹配助手 - 弹窗逻辑

const STORAGE_KEY = {
  apiKey: 'apiKey',
  profile: 'profile',
  resumeText: 'resumeText',
  history: 'history',
};

const HISTORY_LIMIT = 5;

const state = {
  apiKey: '',
  profile: null,
  resumeText: '',
  currentJD: { title: '', url: '', text: '' },
  currentMatch: null,
};

// ===== 提示词 =====
const RESUME_SYSTEM_PROMPT = `你是一位资深招聘与简历分析专家。用户会提供一份简历文本，请提取并整理成结构化的「简历画像」，用于后续与岗位 JD 做匹配。

请只输出一个 JSON 对象，不要输出任何其他文字或解释。JSON 结构如下：
{
  "summary": "一句话个人概述，例如「5 年经验的 Java 后端工程师，方向偏分布式系统」",
  "skills": ["技能1", "技能2"],
  "keywords": ["可用于匹配的关键词标签：技术栈、行业、证书、工具等"],
  "experience": [{"company": "公司", "title": "职位", "duration": "时间段", "highlights": ["核心亮点"]}],
  "education": [{"school": "学校", "degree": "学历", "major": "专业", "time": "时间"}],
  "projects": [{"name": "项目名", "description": "一句话描述"}],
  "certifications": ["证书/奖项"],
  "hardRequirements": {"degree": "最高学历", "yearsOfExperience": "工作年限", "techStack": ["核心技术栈"]},
  "strengths": ["核心竞争优势"]
}

要求：忠实于简历原文，不要编造简历中不存在的信息；缺少的字段用空数组 [] 或空字符串 "" 表示。`;

const MATCH_SYSTEM_PROMPT = `你是一位资深招聘专家。你会收到一份「简历画像」（JSON）和一份「岗位 JD」文本，请评估候选人与该岗位的匹配度。

请只输出一个 JSON 对象，不要输出任何其他文字。JSON 结构如下：
{
  "score": 0到100的整数匹配度评分,
  "successRate": "高" 或 "中" 或 "低",
  "successRateNote": "一句话说明投递成功率的判断依据",
  "matches": ["命中点：JD 要求且候选人具备的，每条一句话，最多5条"],
  "gaps": ["差距点：JD 要求但候选人缺少或简历未体现的，每条一句话，最多5条"],
  "resumeSuggestions": ["针对该岗位的简历优化建议，具体可操作，最多5条"],
  "interviewTips": ["面试可能被问到的问题或准备要点，最多5条"],
  "summary": "总体一句话评价"
}

评分要客观：综合考虑学历、年限、技能、经验相关度等硬性条件；不要为了安慰而虚高。`;

const GREETING_SYSTEM_PROMPT = `你是求职沟通专家。请根据「简历画像」、「岗位 JD」以及匹配结果，生成一条用于招聘平台主动联系招聘方的「打招呼语」。

要求：
- 字数控制在 50～80 个汉字之间
- 结构：一句自我介绍 + 一个最突出的匹配点 + 一句行动邀请（如「期待进一步沟通」）
- 语气真诚、简洁、专业，不要夸大，不要使用表情符号
- 只输出一个 JSON 对象，不要输出其他文字。结构：{"greeting": "招呼语内容", "length": 字数}`;

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', init);

async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
  bindEvents();

  const data = await chrome.storage.local.get([STORAGE_KEY.apiKey, STORAGE_KEY.profile, STORAGE_KEY.resumeText, STORAGE_KEY.history]);
  state.apiKey = data[STORAGE_KEY.apiKey] || '';
  state.profile = data[STORAGE_KEY.profile] || null;
  state.resumeText = data[STORAGE_KEY.resumeText] || '';

  document.getElementById('api-key').value = state.apiKey;
  if (state.resumeText) {
    document.getElementById('resume-text').value = state.resumeText;
  }
  if (state.profile) {
    renderProfile(state.profile);
    setStatus('profile', `已有简历画像（更新于 ${formatTime(state.profile.updatedAt)}）`, 'ok');
  }
  renderHistory(data[STORAGE_KEY.history] || []);
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('save-key').addEventListener('click', saveApiKey);
  document.getElementById('api-key').addEventListener('change', saveApiKey);

  document.getElementById('resume-file').addEventListener('change', onFileChange);

  const textarea = document.getElementById('resume-text');
  textarea.addEventListener('input', () => {
    state.resumeText = textarea.value;
    debounceSaveResumeText();
  });

  document.getElementById('analyze-resume').addEventListener('click', analyzeResume);
  document.getElementById('analyze-jd').addEventListener('click', analyzeJD);
}

// ===== 通用工具 =====
function setStatus(tab, msg, type) {
  const id = tab === 'profile' ? 'profile-status' : 'match-status';
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status ' + (type || '');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseJSON(text) {
  if (!text) throw new Error('AI 返回内容为空');
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
    }
    throw new Error('AI 返回的 JSON 无法解析');
  }
}

let resumeSaveTimer = null;
function debounceSaveResumeText() {
  clearTimeout(resumeSaveTimer);
  resumeSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY.resumeText]: state.resumeText });
  }, 600);
}

function callDeepSeek(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'callDeepSeek',
      payload: {
        apiKey: state.apiKey,
        messages,
        jsonMode: !!opts.jsonMode,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      },
    }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (resp && resp.error) reject(new Error(resp.error));
      else if (resp && resp.content) resolve(resp.content);
      else reject(new Error('后台返回异常'));
    });
  });
}

// ===== API Key =====
async function saveApiKey() {
  state.apiKey = document.getElementById('api-key').value.trim();
  await chrome.storage.local.set({ [STORAGE_KEY.apiKey]: state.apiKey });
  setStatus('profile', state.apiKey ? 'API Key 已保存 ✓' : 'API Key 已清空', state.apiKey ? 'ok' : '');
}

// ===== 简历 =====
async function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    setStatus('profile', '仅支持 PDF 文件', 'error');
    return;
  }
  setStatus('profile', '正在解析 PDF…', 'loading');
  try {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf);
    if (!text) {
      setStatus('profile', '未解析出文字（可能是扫描版 PDF），请改用下方手动粘贴', 'error');
      return;
    }
    state.resumeText = text;
    document.getElementById('resume-text').value = text;
    await chrome.storage.local.set({ [STORAGE_KEY.resumeText]: text });
    setStatus('profile', `已解析 PDF，共约 ${text.length} 字。请点击「分析简历」`, 'ok');
  } catch (err) {
    setStatus('profile', `PDF 解析失败：${err.message}（可改用手动粘贴）`, 'error');
  }
}

async function extractPdfText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const parts = content.items.map((it) => (it && 'str' in it ? it.str : ''));
    text += parts.join(' ') + '\n\n';
  }
  return text.trim();
}

async function analyzeResume() {
  const text = document.getElementById('resume-text').value.trim();
  if (!text) {
    setStatus('profile', '请先上传 PDF 或粘贴简历文字', 'error');
    switchTab('resume');
    return;
  }
  if (!state.apiKey) {
    setStatus('profile', '请先填写并保存 API Key', 'error');
    return;
  }

  const btn = document.getElementById('analyze-resume');
  btn.disabled = true;
  setStatus('profile', '正在分析简历，生成 AI 画像…', 'loading');
  try {
    const content = await callDeepSeek(
      [
        { role: 'system', content: RESUME_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 2500 }
    );

    const profile = parseJSON(content);
    profile.updatedAt = Date.now();
    state.profile = profile;
    await chrome.storage.local.set({ [STORAGE_KEY.profile]: profile });

    renderProfile(profile);
    setStatus('profile', '画像已生成并保存 ✓', 'ok');
  } catch (err) {
    setStatus('profile', '分析失败：' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderProfile(p) {
  const el = document.getElementById('profile-view');
  const exp = (p.experience || [])
    .map((e) => `${escapeHtml(e.title || '')} @ ${escapeHtml(e.company || '')}（${escapeHtml(e.duration || '')}）`)
    .join('<br>');
  const edu = (p.education || [])
    .map((e) => `${escapeHtml(e.degree || '')} ${escapeHtml(e.major || '')} ${escapeHtml(e.school || '')}（${escapeHtml(e.time || '')}）`)
    .join('<br>');
  const tags = (p.keywords || []).slice(0, 24).map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join('');

  el.innerHTML = `
    <div class="card">
      <div class="profile-section"><strong>概述：</strong>${escapeHtml(p.summary || '')}</div>
      ${tags ? `<div class="profile-section"><h4>关键词标签</h4><div class="tag-list">${tags}</div></div>` : ''}
      ${exp ? `<div class="profile-section"><h4>工作经历</h4><div>${exp}</div></div>` : ''}
      ${edu ? `<div class="profile-section"><h4>教育背景</h4><div>${edu}</div></div>` : ''}
      ${(p.strengths && p.strengths.length) ? `<div class="profile-section"><h4>核心优势</h4><ul>${p.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>` : ''}
      ${(p.certifications && p.certifications.length) ? `<div class="profile-section"><h4>证书 / 奖项</h4><div>${p.certifications.map(escapeHtml).join('、')}</div></div>` : ''}
    </div>
  `;
  el.classList.remove('hidden');
}

// ===== JD 匹配 =====
function extractJDFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          const clean = (s) => String(s || '')
            .replace(/ /g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          const getMain = () => {
            const selectors = [
              'main', 'article', '[role="main"]',
              '.job-detail', '.job_detail', '.jobDetail', '.job-description', '.job_description', '.job-detail-content',
              '.description', '.detail-content', '.job-description-content',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText && el.innerText.trim().length > 100) {
                return el.innerText;
              }
            }
            let best = '';
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
              if (!node.children || node.children.length === 0) continue;
              const t = node.innerText;
              if (t && t.trim().length > best.length) best = t;
              if (best.length > 20000) break;
            }
            return best || document.body.innerText;
          };

          const selected = window.getSelection ? window.getSelection().toString() : '';
          const sel = clean(selected);
          const text = sel.length >= 20 ? sel : clean(getMain());
          return {
            title: document.title || '',
            url: location.href || '',
            selected: sel,
            text,
          };
        },
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const r = results && results[0] && results[0].result;
        if (r) resolve(r);
        else reject(new Error('无法读取当前页面内容'));
      }
    );
  });
}

async function analyzeJD() {
  if (!state.apiKey) {
    setStatus('match', '请先在「简历」页填写 API Key', 'error');
    switchTab('resume');
    return;
  }
  if (!state.profile) {
    setStatus('match', '请先在「简历」页生成简历画像', 'error');
    switchTab('resume');
    return;
  }

  const btn = document.getElementById('analyze-jd');
  btn.disabled = true;
  setStatus('match', '正在读取当前页面…', 'loading');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('未找到当前标签页');
    if (tab.url && /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)) {
      throw new Error('无法在浏览器内部页面使用，请打开普通的 JD 网页');
    }

    const jd = await extractJDFromTab(tab.id);
    if (!jd.text || jd.text.trim().length < 20) {
      throw new Error('页面内容过少，请手动选中 JD 正文文字后再试');
    }
    state.currentJD = jd;

    setStatus('match', '正在分析匹配度…', 'loading');
    const content = await callDeepSeek(
      [
        { role: 'system', content: MATCH_SYSTEM_PROMPT },
        { role: 'user', content: buildMatchUserMessage() },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 2000 }
    );

    const match = parseJSON(content);
    state.currentMatch = match;
    await addHistory(match, jd);

    renderMatch(match, { withGreeting: true });
    setStatus('match', '分析完成 ✓', 'ok');
  } catch (err) {
    setStatus('match', '分析失败：' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function buildMatchUserMessage() {
  const jdText = state.currentJD.text.slice(0, 8000);
  return `简历画像：\n${JSON.stringify(state.profile, null, 2)}\n\n岗位 JD：\n${jdText}`;
}

function renderMatch(match, { withGreeting = true } = {}) {
  const view = document.getElementById('match-view');
  const scoreColor = match.score >= 70 ? '#16a34a' : match.score >= 45 ? '#d97706' : '#dc2626';
  const rateClass = match.successRate === '高' ? 'high' : match.successRate === '低' ? 'low' : 'mid';
  const list = (items) => (items && items.length)
    ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : '<p class="hint">无</p>';

  view.innerHTML = `
    <div class="card">
      <div class="score-wrap">
        <div class="score" style="background:${scoreColor}">${match.score}</div>
        <div>
          <span class="badge ${rateClass}">投递成功率：${escapeHtml(match.successRate || '—')}</span>
          <p class="hint" style="margin-top:4px">${escapeHtml(match.successRateNote || '')}</p>
        </div>
      </div>
      <p class="profile-summary"><strong>总体评价：</strong>${escapeHtml(match.summary || '')}</p>

      <div class="match-section good"><h4>✓ 命中点</h4>${list(match.matches)}</div>
      <div class="match-section bad"><h4>✗ 差距点</h4>${list(match.gaps)}</div>
      <div class="match-section neutral"><h4>简历优化建议</h4>${list(match.resumeSuggestions)}</div>
      <div class="match-section neutral"><h4>面试准备提示</h4>${list(match.interviewTips)}</div>

      <p class="hint">注：投递成功率为 AI 估算，仅供参考。</p>
      ${withGreeting ? `
        <button id="gen-greeting" class="btn btn-primary" style="margin-top:10px">生成打招呼语</button>
        <div id="greeting-box" class="greeting-box hidden">
          <div class="greeting-head">
            <strong>打招呼语</strong>
            <button id="copy-greeting" class="btn btn-secondary" style="padding:4px 10px">复制</button>
          </div>
          <div id="greeting-text"></div>
        </div>
      ` : ''}
    </div>
  `;
  view.classList.remove('hidden');

  if (withGreeting) {
    document.getElementById('gen-greeting').addEventListener('click', generateGreeting);
    document.getElementById('copy-greeting').addEventListener('click', copyGreeting);
  }
}

// ===== 打招呼语 =====
async function generateGreeting() {
  if (!state.currentMatch || !state.currentJD.text) return;
  const btn = document.getElementById('gen-greeting');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const content = await callDeepSeek(
      [
        { role: 'system', content: GREETING_SYSTEM_PROMPT },
        { role: 'user', content: buildGreetingUserMessage() },
      ],
      { jsonMode: true, temperature: 0.6, maxTokens: 300 }
    );

    const g = parseJSON(content);
    const greeting = (g && (g.greeting || g.text)) || content;
    document.getElementById('greeting-text').textContent = greeting;
    document.getElementById('greeting-box').classList.remove('hidden');
  } catch (err) {
    setStatus('match', '生成打招呼语失败：' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成打招呼语';
  }
}

function buildGreetingUserMessage() {
  const m = state.currentMatch;
  const jdText = state.currentJD.text.slice(0, 4000);
  return `简历画像：\n${JSON.stringify(state.profile)}\n\n岗位 JD：\n${jdText}\n\n匹配结果：\n${JSON.stringify({ score: m.score, successRate: m.successRate, matches: m.matches, summary: m.summary })}`;
}

async function copyGreeting() {
  const t = document.getElementById('greeting-text').textContent;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    setStatus('match', '已复制 ✓', 'ok');
  } catch (_) {
    setStatus('match', '复制失败，请手动选择复制', 'error');
  }
}

// ===== 历史 =====
async function addHistory(match, jd) {
  const data = await chrome.storage.local.get(STORAGE_KEY.history);
  let history = data[STORAGE_KEY.history] || [];
  history.unshift({
    ...match,
    jdTitle: jd.title || jd.url,
    jdUrl: jd.url,
    date: new Date().toISOString(),
  });
  if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [STORAGE_KEY.history]: history });
  renderHistory(history);
}

function renderHistory(history) {
  const el = document.getElementById('history-view');
  if (!history || !history.length) {
    el.innerHTML = '<div class="empty">暂无匹配记录</div>';
    return;
  }
  el.innerHTML = history.map((h, i) => `
    <div class="history-item" data-index="${i}">
      <div class="history-head">
        <div class="history-title" title="${escapeHtml(h.jdTitle)}">${escapeHtml(h.jdTitle)}</div>
        <div class="history-score">${h.score} 分</div>
      </div>
      <div class="history-date">${formatTime(h.date)}</div>
    </div>
  `).join('');

  el.querySelectorAll('.history-item').forEach((item) => {
    item.addEventListener('click', () => {
      const h = history[Number(item.dataset.index)];
      state.currentMatch = { ...h };
      state.currentJD = { title: h.jdTitle, url: h.jdUrl, text: '' };
      renderMatch(state.currentMatch, { withGreeting: false });
      switchTab('match');
    });
  });
}
