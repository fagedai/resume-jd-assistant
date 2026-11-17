// shared.js - popup 与 background 共享的常量、提示词与纯工具函数
// 普通脚本（popup 用 <script> 引入）与 service worker（用 importScripts 引入）共用。

const STORAGE_KEY = {
  apiKey: 'apiKey',
  profile: 'profile',
  resumeText: 'resumeText',
  history: 'history',
  shotStatus: 'shotStatus',
};

const HISTORY_LIMIT = 5;

// 结构化 JSON 输出上限：flash 非思考模式默认上限为 8K，给足避免被截断（finish_reason=length）
const MAX_OUTPUT_TOKENS = 8000;
const GREETING_MAX_TOKENS = 800;

// ===== 提示词 =====
const RESUME_SYSTEM_PROMPT = `你是一位资深招聘与简历分析专家。用户会提供一份简历文本，请提取并整理成结构化的「简历画像」，用于后续与岗位 JD 做匹配。画像要保留可用于比对的细节，不要只提炼成空泛标签。

请只输出一个 JSON 对象，不要输出任何其他文字或解释。JSON 结构如下：
{
  "summary": "一句话个人概述，包含身份、方向、核心技术栈，例如「应届生，前端方向，主攻 Vue/React/TypeScript，有两段 B 端业务实习」",
  "skills": ["具体技能，带版本或方向更佳，如 Vue3、React18、TypeScript、Webpack、Canvas"],
  "keywords": ["可用于匹配的关键词标签：技术栈、行业、业务领域、证书、工具等"],
  "experience": [{"company": "公司", "title": "职位", "duration": "时间段", "highlights": ["该段实习/工作的具体职责与产出，尽量保留业务场景和量化结果"]}],
  "education": [{"school": "学校", "degree": "学历", "major": "专业", "time": "时间"}],
  "projects": [{"name": "项目名", "role": "担任角色", "techStack": ["项目用到的技术栈"], "highlights": ["个人职责、关键实现、遇到的难点与成果，保留量化数据"]}],
  "certifications": ["证书/奖项"],
  "hardRequirements": {"degree": "最高学历", "major": "专业", "yearsOfExperience": "工作年限或应届身份", "techStack": ["核心技术栈"]},
  "strengths": ["基于简历事实的核心竞争优势，不要写客套话"]
}

要求：
- 忠实于简历原文，不要编造简历中不存在的信息；缺少的字段用空数组 [] 或空字符串 "" 表示。
- 项目经历必须保留技术栈和具体职责，不要压缩成一句空话。
- 应届生请在 yearsOfExperience 标注「应届」或实习时长，不要写成正式工作年限。`;

const MATCH_SYSTEM_PROMPT = `你是一位资深招聘专家，熟悉前端/互联网岗位的招聘筛选标准。你会收到一份「简历画像」（JSON）和一份「岗位 JD」文本，请评估候选人与该岗位的匹配度。

## 分析步骤
1. 先把 JD 拆解成两类要求：
   - hardRequirements：硬性门槛（学历、工作年限/应届身份、必须掌握的技术栈、必须有过的业务经验），缺一项即视为硬伤。
   - preferred：加分项（有经验优先、熟悉某工具/框架、了解某领域、软技能），不满足不构成硬伤。
2. 再逐条对照简历画像：判断每条要求是「命中 / 部分命中 / 缺失」，区分是硬性缺失还是加分项未覆盖。
3. 结合候选人身份定位打分：如果画像显示为应届生，不要把「多年正式工作经验」「独立负责过大型线上项目」这类社招要求算成硬性差距；应看实习经历、项目深度、技术栈匹配度。

## 评分锚点（0–100 整数）
- 80–100：硬性门槛全部命中，核心技术栈高度吻合，可优先投递。
- 60–79：硬性门槛基本满足，核心技术栈多数吻合，存在少量可弥补的差距，值得投递。
- 40–59：有部分相关经验，但存在明显硬性差距或技术栈偏差，投递回复概率偏低。
- 0–39：硬性门槛大面积不匹配，或方向明显不符，不建议投递。

## 输出要求
只输出一个 JSON 对象，不要输出任何其他文字。结构如下：
{
  "score": 0到100的整数,
  "successRate": "高" 或 "中" 或 "低",
  "successRateNote": "一句话说明投递成功率的判断依据，点明主要支撑项和主要硬伤",
  "jdRequirements": {"hard": ["JD 硬性要求条目"], "preferred": ["JD 加分项条目"]},
  "matches": ["命中点：JD 要求且候选人具备的，每条一句话，最多5条"],
  "gaps": ["差距点：JD 要求但候选人缺少或简历未体现的，标注是硬性缺失还是加分项未覆盖，每条一句话，最多5条"],
  "resumeSuggestions": ["针对该岗位的简历优化建议，具体可操作，最多5条"],
  "interviewTips": ["面试可能被问到的问题或准备要点，最多5条"],
  "summary": "总体一句话评价"
}

要求：
- 评分客观，不要为了安慰而虚高；也不要因为候选人是应届生就压低分数。
- 命中点必须基于画像中真实存在的信息，不要编造候选人没有的技能或经验。
- 差距点要具体，指明缺的是哪一项要求，不要写「综合能力不足」这类空话。`;

const GREETING_SYSTEM_PROMPT = `你是求职沟通专家。请根据「简历画像」「岗位 JD」「匹配结果」，生成一条招聘平台（BOSS 直聘等）主动联系 HR 的「打招呼语」。

## 关键机制（必须遵守）
HR 在消息列表不点开时，只能看到前约 15 个字，这 15 个字决定 HR 是否点开。因此：
- 第一句禁止用「你好/您好」「我对岗位很感兴趣」「我是XX应届生」这类没有信息量的开头；礼貌语和身份介绍放最后或直接省略。
- 开头必须直接放「JD 最看重、且你真实具备」的硬信息，二选一或组合：
  1) 相关实习/工作经验；
  2) 落地项目 + 具体技术/量化成果。
- 先从 JD 识别最核心的 1～2 项要求（某框架、某类业务、某技术），再用画像中真实存在的实习或项目去对应，写出具体名称和技术栈，不要写「熟悉前端开发」这种换个岗位也能用的空话。

## 结构（按此顺序）
1. 开头硬匹配点：直接对应 JD 核心要求的经验/技术/项目，必须进前 15 字
2. 一句具体支撑：实习公司或项目名 + 你做了什么 + 可量化成果；没有量化数据就写具体技术实现，不要编造
3. 基本信息：城市 + 到岗时间（如「深圳，随时到岗」），一句话带过
4. 简短收尾：如「可发完整简历，期待沟通」，不要卑微恳求

## 禁止
- 不写性格、态度、品质（学习能力强、认真负责、开朗等），属无效信息
- 不重复学校、学历、专业（HR 在旁边就能看到）
- 不写「求求您/恳请给个机会/我真的很需要」这类放低姿态的话
- 不用表情符号，不夸大，不编造画像中没有的经历或数据
- 总字数控制在 70～120 字，用短句、分号衔接，不写小作文，不分点编号

只输出一个 JSON 对象，不要输出其他文字。结构：{"greeting": "招呼语内容", "length": 字数}`;

// ===== 通用工具 =====
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

// 招呼语专用解析：正常走 JSON，被截断时用正则抢救 greeting 字段，最后兜底纯文本
function extractGreeting(text) {
  if (!text) return '';
  const raw = String(text);
  try {
    const g = parseJSON(raw);
    if (g && (g.greeting || g.text)) return String(g.greeting || g.text).trim();
  } catch (_) {}

  const m = raw.match(/"greeting"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    const s = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
    if (s) return s;
  }

  const plain = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (plain && plain.indexOf('{') === -1 && plain.length >= 10) return plain;
  return '';
}

// 归一化匹配结果，防止模型漏字段导致渲染报错
function normalizeMatch(m) {
  if (!m || typeof m !== 'object') m = {};
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim() !== '') : []);
  const score = Number.parseInt(m.score, 10);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    successRate: ['高', '中', '低'].includes(m.successRate) ? m.successRate : '中',
    successRateNote: String(m.successRateNote || ''),
    jdRequirements: m.jdRequirements && typeof m.jdRequirements === 'object'
      ? { hard: arr(m.jdRequirements.hard), preferred: arr(m.jdRequirements.preferred) }
      : { hard: [], preferred: [] },
    matches: arr(m.matches),
    gaps: arr(m.gaps),
    resumeSuggestions: arr(m.resumeSuggestions),
    interviewTips: arr(m.interviewTips),
    summary: String(m.summary || ''),
  };
}

// 把后端错误信息分类成可读提示
function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (/401|invalid_api_key|authentication/i.test(msg)) return 'API Key 无效或已失效，请检查后重新保存';
  if (/402|insufficient|balance|余额|quota/i.test(msg)) return 'DeepSeek 账户余额不足或额度用尽，请充值后再试';
  if (/429|rate.?limit|频率/i.test(msg)) return '请求过于频繁，请稍等几秒后重试';
  if (/5\d{2}|网络|fetch|Failed to fetch|NetworkError/i.test(msg)) return '网络请求失败，请检查网络连接后重试';
  if (/JSON 无法解析|返回内容为空|返回被截断|truncat/i.test(msg)) return 'AI 返回格式异常，可重新分析一次';
  return msg;
}

// 构造匹配请求的 user 文本（popup 文本分析与 background 截图分析共用）
function buildMatchUserMessage(profile, jdText) {
  return `简历画像：\n${JSON.stringify(profile, null, 2)}\n\n岗位 JD：\n${String(jdText).slice(0, 8000)}`;
}

// ===== 历史记录 =====
async function addHistory(match, jd) {
  const data = await chrome.storage.local.get(STORAGE_KEY.history);
  let history = data[STORAGE_KEY.history] || [];
  history.unshift({
    ...match,
    jdTitle: jd.title || jd.url,
    jdUrl: jd.url,
    jdText: (jd.text || '').slice(0, 4000),
    profileSnapshot: jd.profileSnapshot || null,
    date: new Date().toISOString(),
  });
  if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [STORAGE_KEY.history]: history });
  return history;
}
