// JD 匹配助手 - 弹窗逻辑
// 共享的常量、提示词与纯函数在 shared.js；后台截图全链路在 background.js。

const state = {
  profile: null,
  resumeText: '',
  currentJD: { title: '', url: '', text: '' },
  currentMatch: null,
};

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', init);

async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
  bindEvents();
  onStorageChanged();

  const data = await chrome.storage.local.get([
    STORAGE_KEY.apiKey, STORAGE_KEY.profile, STORAGE_KEY.resumeText,
    STORAGE_KEY.history, STORAGE_KEY.shotStatus,
  ]);
  state.profile = data[STORAGE_KEY.profile] || null;
  state.resumeText = data[STORAGE_KEY.resumeText] || '';

  document.getElementById('resume-text').value = state.resumeText;
  if (state.profile) {
    renderProfile(state.profile);
    setStatus('profile', `已有简历画像（更新于 ${formatTime(state.profile.updatedAt)}）`, 'ok');
  }
  renderHistory(data[STORAGE_KEY.history] || []);

  // 恢复后台截图任务的进度/结果
  if (data[STORAGE_KEY.shotStatus]) handleShotStatus(data[STORAGE_KEY.shotStatus]);
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
  document.getElementById('analyze-jd-shot').addEventListener('click', analyzeJDByShot);
}

// ===== 通用 =====
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

let resumeSaveTimer = null;
function debounceSaveResumeText() {
  clearTimeout(resumeSaveTimer);
  resumeSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY.resumeText]: state.resumeText });
  }, 600);
}

// apiKey 由 background 从 storage 读取，这里不再传
function callDeepSeek(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'callDeepSeek',
      payload: {
        messages,
        jsonMode: !!opts.jsonMode,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        model: opts.model,
      },
    }, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (resp && resp.error) reject(new Error(resp.error));
      else if (resp && resp.content) resolve(resp.content);
      else reject(new Error('后台返回异常'));
    });
  });
}

// ===== API Key =====
async function saveApiKey() {
  const key = document.getElementById('api-key').value.trim();
  await chrome.storage.local.set({ [STORAGE_KEY.apiKey]: key });
  setStatus('profile', key ? 'API Key 已保存 ✓' : 'API Key 已清空', key ? 'ok' : '');
}

// ===== 简历 =====
async function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) { setStatus('profile', '仅支持 PDF 文件', 'error'); return; }

  setStatus('profile', '正在解析 PDF…', 'loading');
  try {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf);
    if (!text) {
      setStatus('profile', '未解析出文字（可能是扫描版 PDF），请改用手动粘贴', 'error');
      return;
    }
    state.resumeText = text;
    document.getElementById('resume-text').value = text;
    await chrome.storage.local.set({ [STORAGE_KEY.resumeText]: text });
    setStatus('profile', `已解析 PDF，共约 ${text.length} 字，请点击「分析简历」`, 'ok');
  } catch (err) {
    setStatus('profile', `PDF 解析失败：${friendlyError(err)}（可改用手动粘贴）`, 'error');
  }
}

async function extractPdfText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => (it && 'str' in it ? it.str : '')).join(' ') + '\n\n';
  }
  return text.trim();
}

async function analyzeResume() {
  const text = document.getElementById('resume-text').value.trim();
  if (!text) { setStatus('profile', '请先上传 PDF 或粘贴简历文字', 'error'); return; }

  const btn = document.getElementById('analyze-resume');
  btn.disabled = true;
  setStatus('profile', '正在分析简历，生成画像…', 'loading');
  try {
    const content = await callDeepSeek(
      [
        { role: 'system', content: RESUME_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: MAX_OUTPUT_TOKENS }
    );
    const profile = parseJSON(content);
    profile.updatedAt = Date.now();
    state.profile = profile;
    await chrome.storage.local.set({ [STORAGE_KEY.profile]: profile });

    renderProfile(profile);
    setStatus('profile', '画像已生成并保存 ✓', 'ok');
  } catch (err) {
    setStatus('profile', '分析失败：' + friendlyError(err), 'error');
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

  const projHtml = (p.projects || []).map((pr) => {
    const stack = (pr.techStack || []).map(escapeHtml).join(' / ');
    const highlights = (pr.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join('');
    return `<div class="profile-section">
      <div><strong>${escapeHtml(pr.name || '')}</strong>${pr.role ? `（${escapeHtml(pr.role)}）` : ''}${stack ? ` <span class="hint">${stack}</span>` : ''}</div>
      ${highlights ? `<ul>${highlights}</ul>` : ''}
    </div>`;
  }).join('');

  const hr = p.hardRequirements || {};
  const hrText = [hr.degree, hr.major, hr.yearsOfExperience, (hr.techStack || []).join(' / ')].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="card">
      <div class="profile-section"><strong>概述：</strong>${escapeHtml(p.summary || '')}</div>
      ${hrText ? `<div class="profile-section"><h4>硬性条件</h4><div>${escapeHtml(hrText)}</div></div>` : ''}
      ${tags ? `<div class="profile-section"><h4>关键词标签</h4><div class="tag-list">${tags}</div></div>` : ''}
      ${exp ? `<div class="profile-section"><h4>工作经历</h4><div>${exp}</div></div>` : ''}
      ${projHtml ? `<div class="profile-section"><h4>项目经历</h4>${projHtml}</div>` : ''}
      ${edu ? `<div class="profile-section"><h4>教育背景</h4><div>${edu}</div></div>` : ''}
      ${(p.strengths && p.strengths.length) ? `<div class="profile-section"><h4>核心优势</h4><ul>${p.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>` : ''}
      ${(p.certifications && p.certifications.length) ? `<div class="profile-section"><h4>证书 / 奖项</h4><div>${p.certifications.map(escapeHtml).join('、')}</div></div>` : ''}
    </div>
  `;
  el.classList.remove('hidden');
}

// ===== 文本 JD 分析（popup 保持打开，不涉及页面点击） =====
function extractJDFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          const clean = (s) => String(s || '')
            .replace(/ /g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          const SITE_SELECTORS = [
            '.job-detail', '.job-detail-section', '.desc', '.job-sec-text', '.b-job-description',
            '.job-detail', '.position-description', '.job-description', '.summary-content',
            '.job-detail', '.tCompany_main', '.job_msg', '.bmsg.job_msg',
            '.job-detail', '.describtion', '.job_primary', '.position-detail',
            'main', 'article', '[role="main"]',
            '.job-description', '.job_description', '.job-detail-content',
            '.description', '.detail-content', '.job-description-content',
            '.position-info', '.job-info',
          ];
          const NOISE_SELECTORS = [
            'aside', 'nav', 'footer', 'header', '.sidebar', '.side-bar', '.recommend',
            '.recommend-job', '.job-recommend', '.related-job', '.company-info', '.company-detail',
            '.footer', '.header', '.nav', '.breadcrumb', '.faq', '.feedback', '.advert',
            '.rec-list', '.hot-job', '.similar-job', '.right-bar', '.side-bar-right',
          ];
          const NOISE_KEYWORDS = [
            '推荐职位', '相似职位', '相关职位', '热门职位', '公司介绍', '公司福利',
            '职位对比', '附近职位', '最新职位', '查看更多', '扫码', '下载APP',
            '版权所有', 'ICP备案', '免责声明', '猜你喜欢', '大家都在看',
          ];
          const cloneWithoutNoise = (root) => {
            const el = root.cloneNode(true);
            NOISE_SELECTORS.forEach((sel) => el.querySelectorAll(sel).forEach((n) => n.remove()));
            return el;
          };
          const scoreBlock = (text) => {
            if (!text) return -1;
            const t = text.trim();
            if (t.length < 60) return -1;
            let score = t.length;
            ['岗位职责', '任职要求', '职位要求', '岗位要求', '职责描述', '任职资格', '技能要求', '职位描述']
              .forEach((kw) => { if (t.includes(kw)) score += 300; });
            NOISE_KEYWORDS.forEach((kw) => { if (t.includes(kw)) score -= 120; });
            score += (t.match(/\n/g) || []).length * 5;
            return score;
          };
          const getMain = () => {
            let bestText = ''; let bestScore = -1;
            for (const sel of SITE_SELECTORS) {
              document.querySelectorAll(sel).forEach((node) => {
                const t = clean(cloneWithoutNoise(node).innerText);
                const s = scoreBlock(t);
                if (s > bestScore) { bestScore = s; bestText = t; }
              });
            }
            if (bestScore > 200) return bestText;

            let fallback = ''; let fallbackScore = -1;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
              if (!node.children || node.children.length === 0) continue;
              const t = clean(cloneWithoutNoise(node).innerText);
              const s = scoreBlock(t);
              if (s > fallbackScore) { fallbackScore = s; fallback = t; }
              if (fallback.length > 20000) break;
            }
            return fallback || clean(document.body.innerText);
          };

          const selected = window.getSelection ? window.getSelection().toString() : '';
          const sel = clean(selected);
          const text = sel.length >= 20 ? sel : getMain();
          return { title: document.title || '', url: location.href || '', selected: sel, text };
        },
      },
      (results) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        const r = results && results[0] && results[0].result;
        if (r) resolve(r);
        else reject(new Error('无法读取当前页面内容'));
      }
    );
  });
}

async function analyzeJD() {
  if (!state.profile) { setStatus('match', '请先在「简历」页生成简历画像', 'error'); return; }

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
      throw new Error('页面内容过少，请手动选中 JD 正文，或改用截图框选');
    }
    jd.profileSnapshot = state.profile;
    await runMatchAnalysis(jd);
  } catch (err) {
    setStatus('match', '分析失败：' + friendlyError(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function runMatchAnalysis(jd) {
  state.currentJD = jd;
  document.getElementById('shot-progress').classList.add('hidden');
  setStatus('match', '正在分析匹配度…', 'loading');
  const content = await callDeepSeek(
    [
      { role: 'system', content: MATCH_SYSTEM_PROMPT },
      { role: 'user', content: buildMatchUserMessage(state.profile, jd.text) },
    ],
    { jsonMode: true, temperature: 0.2, maxTokens: MAX_OUTPUT_TOKENS }
  );
  const match = normalizeMatch(parseJSON(content));
  state.currentMatch = match;
  await addHistory(match, jd);

  renderMatch(match, { withGreeting: true });
  setStatus('match', '分析完成 ✓', 'ok');
}

// ===== 截图框选：仅启动后台，进度走 storage =====
async function analyzeJDByShot() {
  if (!state.profile) { setStatus('match', '请先在「简历」页生成简历画像', 'error'); return; }

  const btn = document.getElementById('analyze-jd-shot');
  btn.disabled = true;
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'startShotAnalysis' }, (r) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r);
      });
    });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || '启动失败');
    setStatus('match', '已在页面启动框选，可关闭本弹窗，完成后回来查看', '');
  } catch (err) {
    setStatus('match', '分析失败：' + friendlyError(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

// 监听后台截图状态
function onStorageChanged() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY.shotStatus]) {
      handleShotStatus(changes[STORAGE_KEY.shotStatus].newValue);
    }
  });
}

function handleShotStatus(status) {
  if (!status) return;
  const box = document.getElementById('shot-progress');
  const busy = ['selecting', 'capturing', 'recognizing', 'matching'].includes(status.phase);

  if (busy) {
    box.className = 'progress-box';
    box.innerHTML = `<span class="spinner"></span><span class="progress-msg">${escapeHtml(status.message)}</span>`;
    box.classList.remove('hidden');
    return;
  }
  if (status.phase === 'done') {
    box.className = 'progress-box done';
    box.innerHTML = `<span class="spinner">✓</span><span class="progress-msg">${escapeHtml(status.message)}</span>`;
    box.classList.remove('hidden');
    if (status.match) {
      state.currentMatch = status.match;
      state.currentJD = status.jd || state.currentJD;
      renderMatch(status.match, { withGreeting: true });
    }
    return;
  }
  if (status.phase === 'error') {
    box.className = 'progress-box error';
    box.innerHTML = `<span class="spinner">!</span><span class="progress-msg">${escapeHtml(status.message)}</span>`;
    box.classList.remove('hidden');
    return;
  }
  // canceled：隐藏进度框
  box.classList.add('hidden');
}

// ===== 匹配结果渲染 =====
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

      ${(match.jdRequirements && (match.jdRequirements.hard.length || match.jdRequirements.preferred.length)) ? `
        <div class="match-section neutral">
          <h4>JD 要求拆解</h4>
          ${match.jdRequirements.hard.length ? `<div class="hint">硬性门槛：</div><ul>${match.jdRequirements.hard.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
          ${match.jdRequirements.preferred.length ? `<div class="hint" style="margin-top:4px">加分项：</div><ul>${match.jdRequirements.preferred.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
        </div>` : ''}

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
            <button id="copy-greeting" class="btn btn-outline">复制</button>
          </div>
          <div id="greeting-text"></div>
        </div>` : ''}
    </div>
  `;
  view.classList.remove('hidden');

  if (withGreeting) {
    document.getElementById('gen-greeting').addEventListener('click', generateGreeting);
    document.getElementById('copy-greeting').addEventListener('click', copyGreeting);
  }
}

// ===== 招呼语 =====
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
      { jsonMode: true, temperature: 0.6, maxTokens: GREETING_MAX_TOKENS }
    );
    const greeting = extractGreeting(content);
    if (!greeting) throw new Error('AI 返回的 JSON 无法解析');
    document.getElementById('greeting-text').textContent = greeting;
    document.getElementById('greeting-box').classList.remove('hidden');
  } catch (err) {
    setStatus('match', '生成打招呼语失败：' + friendlyError(err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成打招呼语';
  }
}

function buildGreetingUserMessage() {
  const m = state.currentMatch;
  const p = state.profile || {};
  const slimProfile = {
    summary: p.summary || '',
    skills: p.skills || [],
    keywords: p.keywords || [],
    hardRequirements: p.hardRequirements || {},
    strengths: p.strengths || [],
    experience: (p.experience || []).map((e) => ({ company: e.company, title: e.title, duration: e.duration, highlights: (e.highlights || []).slice(0, 2) })),
    projects: (p.projects || []).map((pr) => ({ name: pr.name, techStack: pr.techStack || [], highlights: (pr.highlights || []).slice(0, 2) })),
  };
  return `候选人画像（精简）：\n${JSON.stringify(slimProfile)}\n\n岗位 JD：\n${state.currentJD.text.slice(0, 3000)}\n\n匹配结果：\n${JSON.stringify({ score: m.score, successRate: m.successRate, matches: m.matches, gaps: m.gaps, summary: m.summary })}`;
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
      state.currentJD = { title: h.jdTitle, url: h.jdUrl, text: h.jdText || '' };
      if (h.profileSnapshot) state.profile = h.profileSnapshot;
      renderMatch(state.currentMatch, { withGreeting: false });
      switchTab('match');
    });
  });
}
