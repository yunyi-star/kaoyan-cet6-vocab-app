/* 背单词 App 核心逻辑: SM-2 间隔重复 + localStorage 持久化 */
'use strict';

/* ================= 数据 ================= */
// WORDS 由 words-data.js 提供: [{w,ph,t,ky,c6,kyF,c6F,imp,bs,ex,r,c}]

const STORE_KEY = 'vocabApp.v1';
const TAG_NAMES = { 3: '双重点', 2: '考研重点', 1: '六级重点', 0: '普通词' };

const state = loadState();
let studyQueue = [];      // 本次学习队列: {word, isNew}
let studyIndex = 0;
let studyTotal = 0;
let curExampleEn = '';    // 当前卡的英文例句(供发音)

/* ================= 状态管理 ================= */
function defaultState() {
  return {
    settings: { daily: 20, scope: 'key', basic: false, autoSpeak: true },
    progress: {},          // w -> {ef, ivl, reps, due(ts)}
    daily: { date: today(), newDone: 0, revDone: 0 },
    streak: { last: '', count: 0 },
    spell: {},             // w -> {ok, bad, weak} 拼写记录, weak=最近一次没拼对
  };
}
function dateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function today() { return dateStr(new Date()); }
function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return dateStr(d); }
// 本地零点 + n 天(按日历日计, 跨夏令时也准确)
function dayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (offsetDays || 0));
  return d.getTime();
}
// 连续天数: 最后一次学习既不是今天也不是昨天 -> 已中断, 显示0
function currentStreak() {
  const last = state.streak.last;
  return (last === today() || last === yesterday()) ? state.streak.count : 0;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
// 真题例句常带选项前缀 "D) " / "[B] ", 去掉
function cleanExample(s) { return String(s || '').replace(/^\s*[\[(]?[A-Da-d][\])]\s*/, '').trim(); }
function isMastered(p) { return p.reps >= 3 && p.ivl >= 21; }
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const def = defaultState();
      return {
        settings: Object.assign(def.settings, s.settings || {}),
        progress: s.progress || {},
        daily: s.daily || def.daily,
        streak: s.streak || def.streak,
        spell: s.spell || {},
      };
    }
  } catch (e) { /* 损坏则重建 */ }
  return defaultState();
}
function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

function rollDaily() {
  const t = today();
  if (state.daily.date !== t) {
    state.daily = { date: t, newDone: 0, revDone: 0 };
    saveState();
  }
}

/* ================= 词表工具 ================= */
// 学习顺序: 重点等级降序 -> 综合词频降序
const STUDY_ORDER = WORDS.slice().sort((a, b) =>
  (b.imp - a.imp) || ((b.kyF + b.c6F) - (a.kyF + a.c6F)));
const WORD_MAP = {};
WORDS.forEach(w => { WORD_MAP[w.w] = w; });

function eligibleNewWords() {
  return STUDY_ORDER.filter(w => {
    if (state.progress[w.w]) return false;
    if (!state.settings.basic && w.bs) return false;
    if (state.settings.scope === 'key' && w.imp === 0) return false;
    return true;
  });
}
function dueReviews(now) {
  // 今天之内到期的都算(兼容旧版按"答题时刻+N×24h"存的到期时间)
  const cutoff = Math.max(now, dayStart(1) - 1);
  const list = [];
  for (const w in state.progress) {
    const p = state.progress[w];
    if (p.due <= cutoff && WORD_MAP[w]) list.push({ word: WORD_MAP[w], isNew: false });
  }
  list.sort((a, b) => (b.word.imp - a.word.imp) || (b.word.kyF - a.word.kyF)); // 重点词优先复习
  return list;
}

/* ================= SM-2 调度 ================= */
// q: 2=忘了 3=模糊 4=认识
function schedule(word, q) {
  let p = state.progress[word.w] || { ef: 2.5, ivl: 0, reps: 0, due: 0 };
  let ef = p.ef, ivl = p.ivl, reps = p.reps;
  if (q < 3) {
    ef = Math.max(1.3, ef - 0.2);
    ivl = 0; reps = 0;
  } else {
    ef = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    if (q === 3) {
      ivl = reps === 0 ? 1 : Math.max(1, Math.round(ivl * 0.6));
    } else {
      ivl = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(ivl * ef);
    }
    reps += 1;
  }
  // 按日历日到期: 晚上学的词第二天一早就能复习, 而不是要等到第二天同一时刻
  const due = ivl === 0 ? Date.now() : dayStart(ivl);
  state.progress[word.w] = { ef: Math.round(ef * 100) / 100, ivl, reps, due };
  saveState();
  return ivl === 0; // 返回是否需要当场重现
}

/* ================= 页面路由 ================= */
function nav(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('scr-' + name).classList.add('active');
  if (name === 'home') renderHome();
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
}
document.querySelectorAll('[data-nav]').forEach(btn =>
  btn.addEventListener('click', () => nav(btn.dataset.nav)));

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ================= 首页 ================= */
function renderHome() {
  rollDaily();
  const now = Date.now();
  const reviews = dueReviews(now);
  const dailyLeft = Math.max(0, state.settings.daily - state.daily.newDone);
  const news = eligibleNewWords().slice(0, dailyLeft);
  const d = new Date();
  document.getElementById('home-date').textContent =
    d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const h = d.getHours();
  document.getElementById('home-greeting').textContent =
    h < 5 ? '夜深了，早些休息' : h < 11 ? '早安，开始今日精进' : h < 14 ? '午间，温故而知新'
      : h < 18 ? '下午好，稳步积累' : '晚上好，今日事今日毕';
  document.getElementById('home-new').textContent = news.length;
  document.getElementById('home-review').textContent = reviews.length;
  const done = state.daily.newDone + state.daily.revDone;
  document.getElementById('home-done').textContent =
    '今日已完成 新词 ' + state.daily.newDone + ' · 复习 ' + state.daily.revDone;
  const startBtn = document.getElementById('btn-start');
  const total = news.length + reviews.length;
  startBtn.disabled = total === 0;
  startBtn.textContent = total === 0 ? '今日已完成' : (done > 0 ? '继续学习' : '开始学习');

  // 今日进度环
  const pct = total + done === 0 ? 0 : Math.round(done / (done + total) * 100);
  document.getElementById('home-pct').textContent = (total === 0 && done === 0 ? 100 : pct) + '%';
  const C = 2 * Math.PI * 52;
  const ring = document.getElementById('home-ring');
  ring.style.strokeDashoffset = String(C * (1 - (total === 0 ? 1 : pct / 100)));
  ring.style.opacity = (total > 0 && pct === 0) ? '0' : '1'; // 0%时圆头线帽会留一个点

  const scopeTxt = state.settings.scope === 'key' ? '仅重点词' : '全部词汇';
  document.getElementById('home-range').textContent =
    scopeTxt + (state.settings.basic ? ' · 含基础词' : '') + ' · 每日新词 ' + state.settings.daily;
  const ps = Object.values(state.progress);
  const learned = ps.length;
  document.getElementById('home-learned').textContent = learned;
  document.getElementById('home-mastered').textContent = ps.filter(isMastered).length;
  document.getElementById('home-streak').textContent = currentStreak();
  document.getElementById('home-overall').textContent = learned + ' / ' + WORDS.length;
  const weak = weakSpellWords().length;
  document.getElementById('home-spell-info').textContent =
    learned === 0 ? '· 学过的词才能练' : weak ? '· ' + weak + ' 词待巩固' : '· ' + learned + ' 词可练';
  document.getElementById('home-vp').style.width = (learned / WORDS.length * 100).toFixed(2) + '%';
}

/* ================= 发音 (美音) ================= */
const hasTTS = typeof speechSynthesis !== 'undefined'
  && typeof SpeechSynthesisUtterance !== 'undefined';
let usVoice = undefined;      // undefined=未选, null=无可用美音
let voicesReady = false;      // 声音列表是否已加载(Chrome首次为空)
let lastUtter = null;         // 上一条入队utterance的事件状态 {started, ended}
let speakRetryTimer = null;   // speak被引擎竞态静默吞掉后的兜底重试定时器
let pendingSpeak = null;      // 声音未就绪时暂存的待读内容
let warnedTTS = false;        // 只提示一次错误

function pickVoice() {
  if (!hasTTS) return null;
  const vs = speechSynthesis.getVoices() || [];
  if (vs.length) voicesReady = true;
  if (usVoice !== undefined && voicesReady) return usVoice;
  const us = vs.filter(v => (v.lang || '').replace('_', '-').toLowerCase().startsWith('en-us'));
  // 优先自然语音, 其次Google/Microsoft系统语音
  usVoice = us.find(v => /natural|neural|online/i.test(v.name))
    || us.find(v => /google|microsoft/i.test(v.name))
    || us[0] || null;
  return usVoice;
}
if (hasTTS) {
  speechSynthesis.onvoiceschanged = () => {
    usVoice = undefined;
    pickVoice();
    // 声音列表加载完成, 补读之前被暂存的内容
    if (pendingSpeak) { const p = pendingSpeak; pendingSpeak = null; doSpeak(p.text, p.rate); }
  };
  pickVoice();
}

function speak(text, rate) {
  if (!hasTTS || !text) return;
  pickVoice(); // 顺便刷新声音列表
  if (!voicesReady) {
    // Chrome刚打开页面时声音列表为空, 此时speak()会静默失败
    // 暂存等 voiceschanged 触发后补读; 800ms兜底防止事件不触发
    pendingSpeak = { text: text, rate: rate };
    setTimeout(() => {
      if (pendingSpeak) { const p = pendingSpeak; pendingSpeak = null; doSpeak(p.text, p.rate); }
    }, 800);
    return;
  }
  doSpeak(text, rate);
}

function doSpeak(text, rate) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = rate || 0.92;
    u.volume = 1;
    const v = pickVoice();
    if (v) u.voice = v;
    // 自己跟踪utterance状态。不信任speechSynthesis.speaking/pending——
    // Windows Chrome/Edge上它们经常在朗读结束后仍卡在true, 一旦卡住,
    // 后续每次朗读都会走cancel路径被吞掉且兜底重试也被挡住, 表现为永久静默。
    const st = { started: false, ended: false };
    u.onstart = () => { st.started = true; };
    u.onend = () => { st.ended = true; };
    u.onerror = ev => {
      st.ended = true;
      if (ev.error && ev.error !== 'interrupted' && ev.error !== 'canceled' && !warnedTTS) {
        warnedTTS = true;
        toast('朗读失败(' + ev.error + '), 请检查浏览器语音设置');
      }
    };
    clearTimeout(speakRetryTimer);
    // 仅当上一条还没结束(在播或排队中)才cancel, 避免排队堆积;
    // 引擎空闲时绝不cancel——空闲cancel正是Chrome吞音bug的触发条件。
    if (lastUtter && !lastUtter.ended) {
      try { speechSynthesis.cancel(); } catch (e) { /* 个别浏览器拒绝合成 */ }
    }
    lastUtter = st;
    try { speechSynthesis.speak(u); } catch (e) { /* 个别浏览器拒绝合成 */ }
    // 兜底自愈: 600ms内连onstart/onend/onerror都没触发(被竞态静默吞掉),
    // cancel后重读一次。只看自己的事件, 不看引擎标志。
    speakRetryTimer = setTimeout(() => {
      if (!st.started && !st.ended) {
        try { speechSynthesis.cancel(); } catch (e) { /* 个别浏览器拒绝合成 */ }
        try { speechSynthesis.speak(u); } catch (e) { /* 个别浏览器拒绝合成 */ }
      }
    }, 600);
  } catch (e) { /* 个别浏览器拒绝合成 */ }
}

function speakWord() { speak(studyQueue[studyIndex] ? studyQueue[studyIndex].word.w : ''); }
function speakExample() { speak(curExampleEn, 0.88); }

document.getElementById('btn-speak-front').addEventListener('click', ev => { ev.stopPropagation(); speakWord(); });
document.getElementById('btn-speak-back').addEventListener('click', speakWord);
document.getElementById('btn-speak-ex').addEventListener('click', speakExample);

/* ================= 学习流程 ================= */
document.getElementById('btn-start').addEventListener('click', startStudy);
document.getElementById('btn-exit').addEventListener('click', () => { studyQueue = []; nav('home'); });

function startStudy() {
  rollDaily();
  const now = Date.now();
  const reviews = dueReviews(now);
  const dailyLeft = Math.max(0, state.settings.daily - state.daily.newDone);
  const news = eligibleNewWords().slice(0, dailyLeft).map(w => ({ word: w, isNew: true }));
  studyQueue = reviews.concat(news);   // 复习优先
  if (studyQueue.length === 0) { toast('今日任务已完成'); return; }
  studyIndex = 0;
  studyTotal = studyQueue.length;
  nav('study');
  showCard();
}

function showCard() {
  if (studyIndex >= studyQueue.length) { finishStudy(); return; }
  const { word, isNew } = studyQueue[studyIndex];
  document.getElementById('study-progress').textContent = (studyIndex + 1) + ' / ' + studyQueue.length;
  document.getElementById('study-type').textContent = isNew ? '新词' : '复习';
  document.getElementById('study-bar').style.width = (studyIndex / studyQueue.length * 100) + '%';

  // 正面
  const tags = document.getElementById('word-tags');
  tags.innerHTML = '';
  const tag = document.createElement('span');
  tag.className = 'tag tag-' + word.imp;
  tag.textContent = TAG_NAMES[word.imp];
  tags.appendChild(tag);
  if (word.bs) { const b = document.createElement('span'); b.className = 'tag tag-basic'; b.textContent = '基础词'; tags.appendChild(b); }
  document.getElementById('word-text').textContent = word.w;
  document.getElementById('word-ph').textContent = word.ph ? '/' + word.ph + '/' : '';
  document.getElementById('word-freq').textContent =
    (word.ky ? '考研词频 ' + word.kyF : '') + (word.ky && word.c6 ? ' · ' : '') + (word.c6 ? '六级词频 ' + word.c6F : '');

  // 背面
  document.getElementById('word-text2').textContent = word.w;
  document.getElementById('word-ph2').textContent = word.ph ? '/' + word.ph + '/' : '';
  document.getElementById('word-def').textContent = word.t || '';
  document.getElementById('word-root').textContent = (word.r || '（暂无拆解）').replace(/\s*->\s*/g, ' → ');
  const exampleEl = document.getElementById('word-example');
  const exampleZhEl = document.getElementById('word-example-zh');
  if (word.c && word.c.length === 2) {
    exampleEl.textContent = word.c[0];
    exampleZhEl.textContent = word.c[1];
    curExampleEn = word.c[0];
  } else if (cleanExample(word.ex)) {
    curExampleEn = cleanExample(word.ex);
    exampleEl.textContent = curExampleEn;
    exampleZhEl.textContent = '—— 六级真题';
  } else {
    exampleEl.textContent = '（暂无例句）';
    exampleZhEl.textContent = '';
    curExampleEn = '';
  }
  document.getElementById('btn-speak-ex').style.visibility = curExampleEn ? 'visible' : 'hidden';

  // 显示正面时自动读单词(美音)
  if (state.settings.autoSpeak) speakWord();

  // 先显示正面
  document.getElementById('card-front').style.display = 'flex';
  document.getElementById('card-back').style.display = 'none';
  document.getElementById('reveal-bar').classList.add('show');
  document.getElementById('answer-bar').classList.remove('show');
}

document.getElementById('btn-reveal').addEventListener('click', reveal);
document.getElementById('card-front').addEventListener('click', reveal);

function reveal() {
  document.getElementById('card-front').style.display = 'none';
  document.getElementById('card-back').style.display = 'flex';
  document.getElementById('reveal-bar').classList.remove('show');
  document.getElementById('answer-bar').classList.add('show');
}

document.getElementById('btn-forgot').addEventListener('click', () => answer(2));
document.getElementById('btn-fuzzy').addEventListener('click', () => answer(3));
document.getElementById('btn-know').addEventListener('click', () => answer(4));

function answer(q) {
  // 只在背面(答题栏可见)时接受作答, 防止快捷键/连点越界
  if (!studyQueue[studyIndex] || !document.getElementById('answer-bar').classList.contains('show')) return;
  const { word, isNew, again } = studyQueue[studyIndex];
  rollDaily(); // 学习跨过零点时, 计数记到新的一天
  const requeue = schedule(word, q);
  // 连续天数
  const t = today();
  if (state.streak.last !== t) {
    state.streak.count = state.streak.last === yesterday() ? state.streak.count + 1 : 1;
    state.streak.last = t;
  }
  // 当场重现的卡不重复计数, 否则"忘了"的新词会把复习数虚高
  if (!again) { if (isNew) state.daily.newDone += 1; else state.daily.revDone += 1; }
  saveState();
  studyIndex += 1;
  if (requeue) studyQueue.push({ word, isNew: false, again: true }); // 忘了: 当场重现
  showCard();
}

function finishStudy() {
  const n = studyIndex;
  studyQueue = [];
  nav('home');
  toast('本轮完成 ' + n + ' 张卡片，做得好');
}

// 键盘快捷键: 空格/回车 翻面, 1/2/3 作答, P 发音, Esc 退出
if (typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', ev => {
    if (!document.getElementById('scr-study').classList.contains('active')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    const k = ev.key;
    const onFront = document.getElementById('reveal-bar').classList.contains('show');
    if ((k === ' ' || k === 'Enter') && onFront) { ev.preventDefault(); reveal(); }
    else if (k === '1') answer(2);
    else if (k === '2') answer(3);
    else if (k === '3') answer(4);
    else if (k === 'p' || k === 'P') speakWord();
    else if (k === 'Escape') document.getElementById('btn-exit').click();
  });
  // 页面长时间挂着跨过零点, 回到前台时刷新首页计数
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.getElementById('scr-home').classList.contains('active')) renderHome();
  });
}

/* ================= 拼写练习 ================= */
// 从已学词中出题: 上次拼错/用了提示的词优先, 其余随机; 看释义+听发音写单词
const SPELL_SIZE = 20;
let spellQueue = [];
let spellIndex = 0;
let spellChecked = false;   // 当前题是否已判定(等待"下一个")
let spellHints = 0;         // 当前题已揭示的字母数

function weakSpellWords() {
  return Object.keys(state.spell).filter(w => state.spell[w].weak && state.progress[w] && WORD_MAP[w]);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function startSpell() {
  const learned = Object.keys(state.progress).filter(w => WORD_MAP[w]);
  if (learned.length === 0) { toast('先去学习一些单词，再来练拼写'); return; }
  const weak = shuffle(weakSpellWords());
  const rest = shuffle(learned.filter(w => weak.indexOf(w) < 0));
  spellQueue = weak.concat(rest).slice(0, SPELL_SIZE).map(w => ({ word: WORD_MAP[w], again: false }));
  spellIndex = 0;
  nav('spell');
  showSpell();
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 例句挖空: 单词及其变形(adopt -> adopting)替换成下划线
function clozeSentence(word) {
  let en = '', zh = '';
  if (word.c && word.c.length === 2) { en = word.c[0]; zh = word.c[1]; } else { en = cleanExample(word.ex); }
  if (!en || word.w.length < 3) return null;
  const re = new RegExp('\\b' + escapeRe(word.w) + '[a-z]*', 'gi');
  if (!re.test(en)) return null;
  return { en: escapeHtml(en).replace(re, '<u></u>'), zh: escapeHtml(zh) };
}
function renderMask() {
  const w = spellQueue[spellIndex].word.w;
  document.getElementById('sp-mask').innerHTML = w.split('').map((ch, i) =>
    i < spellHints ? '<b>' + escapeHtml(ch) + '</b>' : (/[a-z]/i.test(ch) ? '_' : escapeHtml(ch))).join('');
}
function showSpell() {
  if (spellIndex >= spellQueue.length) { finishSpell(); return; }
  const { word } = spellQueue[spellIndex];
  spellChecked = false;
  spellHints = 0;
  document.getElementById('spell-progress').textContent = (spellIndex + 1) + ' / ' + spellQueue.length;
  document.getElementById('spell-bar').style.width = (spellIndex / spellQueue.length * 100) + '%';
  document.getElementById('sp-def').textContent = word.t || '';
  document.getElementById('sp-ph').textContent = word.ph ? '/' + word.ph + '/' : '';
  const cz = clozeSentence(word);
  document.getElementById('sp-cloze').innerHTML = cz
    ? '<div class="en">' + cz.en + '</div>' + (cz.zh ? '<div class="zh">' + cz.zh + '</div>' : '') : '';
  renderMask();
  document.getElementById('sp-len').textContent = word.w.length + ' 个字母';
  const input = document.getElementById('sp-input');
  input.value = '';
  input.className = 'sp-input';
  input.readOnly = false;
  document.getElementById('sp-feedback').innerHTML = '';
  document.getElementById('spell-check-text').textContent = '确认';
  document.getElementById('btn-spell-hint').disabled = false;
  if (input.focus) input.focus();
  if (state.settings.autoSpeak) speak(word.w);
}
function spellHint() {
  if (spellChecked || !spellQueue[spellIndex]) return;
  const w = spellQueue[spellIndex].word.w;
  if (spellHints < w.length - 1) spellHints += 1;
  renderMask();
  const input = document.getElementById('sp-input');
  // 输入框里补上已揭示的前缀, 方便接着往下拼
  if (input.value.toLowerCase().indexOf(w.slice(0, spellHints).toLowerCase()) !== 0) input.value = w.slice(0, spellHints);
  if (input.focus) input.focus();
}
function checkSpell() {
  if (!spellQueue[spellIndex]) return;
  if (spellChecked) { spellIndex += 1; showSpell(); return; }
  const item = spellQueue[spellIndex];
  const target = item.word.w;
  const input = document.getElementById('sp-input');
  const val = input.value.trim();
  if (!val) { if (input.focus) input.focus(); return; }
  const correct = val.toLowerCase() === target.toLowerCase();
  spellChecked = true;
  input.readOnly = true;
  input.className = 'sp-input ' + (correct ? 'ok' : 'bad');
  const rec = state.spell[target] || { ok: 0, bad: 0, weak: false };
  if (correct) rec.ok += 1; else rec.bad += 1;
  // 用了提示也算没完全掌握, 留在待巩固里
  rec.weak = !correct || spellHints > 0;
  state.spell[target] = rec;
  saveState();
  const fb = document.getElementById('sp-feedback');
  if (correct) {
    fb.innerHTML = '<div class="verdict ok">' + (spellHints ? '正确（用了提示）' : '正确') + '</div>';
  } else {
    // 逐位比对, 标出拼错的字母
    const a = val.toLowerCase();
    const marked = target.split('').map((ch, i) =>
      a[i] === ch.toLowerCase() ? escapeHtml(ch) : '<span class="x">' + escapeHtml(ch) + '</span>').join('');
    fb.innerHTML = '<div class="verdict bad">拼写错误</div><div class="sp-answer">' + marked + '</div>';
    if (!item.again) spellQueue.push({ word: item.word, again: true }); // 本轮末尾再考一次
  }
  // 判定后隐藏字母遮罩, 答案只在反馈区显示一次
  document.getElementById('sp-mask').textContent = '';
  document.getElementById('sp-len').textContent = '';
  document.getElementById('spell-check-text').textContent = '下一个';
  document.getElementById('btn-spell-hint').disabled = true;
  speak(target);
}
function finishSpell() {
  const n = spellQueue.filter(x => !x.again).length;
  spellQueue = [];
  nav('home');
  toast('拼写练习完成 ' + n + ' 词');
}
document.getElementById('btn-spell').addEventListener('click', startSpell);
document.getElementById('btn-spell-exit').addEventListener('click', () => { spellQueue = []; nav('home'); });
document.getElementById('btn-spell-check').addEventListener('click', checkSpell);
document.getElementById('btn-spell-hint').addEventListener('click', spellHint);
document.getElementById('btn-spell-speak').addEventListener('click', () => {
  if (spellQueue[spellIndex]) speak(spellQueue[spellIndex].word.w);
});
document.getElementById('sp-input').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); checkSpell(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (spellQueue[spellIndex]) speak(spellQueue[spellIndex].word.w); }
});
if (typeof document.addEventListener === 'function') {
  // Esc 退出; 焦点不在输入框时回车也能确认/下一个
  document.addEventListener('keydown', ev => {
    if (!document.getElementById('scr-spell').classList.contains('active')) return;
    if (ev.key === 'Escape') document.getElementById('btn-spell-exit').click();
    else if (ev.key === 'Enter' && ev.target !== document.getElementById('sp-input')) { ev.preventDefault(); checkSpell(); }
  });
}

/* ================= 设置页 ================= */
function renderSettings() {
  document.getElementById('set-daily').textContent = state.settings.daily;
  document.querySelectorAll('.seg-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.scope === state.settings.scope));
  document.getElementById('set-basic').classList.toggle('on', state.settings.basic);
  document.getElementById('set-autospeak').classList.toggle('on', !!state.settings.autoSpeak);
}
// 事件只绑一次。不能放进renderSettings(每次进设置页/每点一次按钮都会重跑),
// 否则addEventListener会不断叠加监听器, 点几次后数值一步跳好几十、卡在上下限。
document.querySelectorAll('.step-btn').forEach(b => b.addEventListener('click', () => {
  state.settings.daily = Math.min(200, Math.max(5, state.settings.daily + parseInt(b.dataset.step)));
  saveState(); renderSettings();
}));
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
  state.settings.scope = b.dataset.scope; saveState(); renderSettings();
}));
document.getElementById('set-basic').addEventListener('click', () => {
  state.settings.basic = !state.settings.basic;
  saveState(); renderSettings();
});
document.getElementById('set-autospeak').addEventListener('click', () => {
  state.settings.autoSpeak = !state.settings.autoSpeak;
  saveState(); renderSettings();
});

document.getElementById('btn-voice-test').addEventListener('click', () => {
  speak('This is an American English pronunciation test.', 0.9);
  toast('若听不到声音, 请检查系统音量或浏览器语音设置');
});

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'vocab-progress-' + today() + '.json';
  // 链接须在文档内且不能立刻revoke, 否则Firefox/Safari下载会失败
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); if (a.remove) a.remove(); }, 1000);
  toast('已导出学习记录');
});
document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', ev => {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s || typeof s.progress !== 'object' || typeof s.settings !== 'object') throw new Error('bad');
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
      location.reload();
    } catch (e) { toast('文件格式不正确'); }
  };
  reader.readAsText(f);
  ev.target.value = '';
});
document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('确定清空全部学习记录? 此操作不可恢复')) {
    localStorage.removeItem(STORE_KEY);
    location.reload();
  }
});

/* ================= 统计页 ================= */
function renderStats() {
  const ps = Object.values(state.progress);
  const learned = ps.length;
  const mastered = ps.filter(isMastered).length;
  document.getElementById('st-learned').textContent = learned;
  document.getElementById('st-reviewing').textContent = learned - mastered;
  document.getElementById('st-mastered').textContent = mastered;
  document.getElementById('st-streak').textContent = currentStreak();
  document.getElementById('st-total').textContent = WORDS.length;
  document.getElementById('st-today').textContent = state.daily.newDone + state.daily.revDone;
  const sp = Object.values(state.spell);
  const spOk = sp.reduce((n, r) => n + r.ok, 0), spAll = sp.reduce((n, r) => n + r.ok + r.bad, 0);
  document.getElementById('st-spell-total').textContent = spAll;
  document.getElementById('st-spell-rate').textContent = spAll ? Math.round(spOk / spAll * 100) + '%' : '—';
  document.getElementById('st-spell-weak').textContent = weakSpellWords().length;

  // 词库构成: 各等级词数 + 已学占比
  const c = { 3: 0, 2: 0, 1: 0, 0: 0 }, l = { 3: 0, 2: 0, 1: 0, 0: 0 };
  WORDS.forEach(w => { c[w.imp] += 1; if (state.progress[w.w]) l[w.imp] += 1; });
  const desc = { 3: '考研 + 六级真题双高频', 2: '考研真题高频', 1: '六级真题高频', 0: '大纲其余词汇' };
  document.getElementById('st-breakdown').innerHTML = [3, 2, 1, 0].map(k =>
    '<div class="bd-row tag-' + k + '"><div class="bd-head"><span>' + TAG_NAMES[k] +
    '<span class="bd-desc">' + desc[k] + '</span></span><span class="bd-num">' + l[k] + ' / ' + c[k] + '</span></div>' +
    '<div class="bd-bar"><i style="width:' + (c[k] ? (l[k] / c[k] * 100).toFixed(1) : 0) + '%"></i></div></div>'
  ).join('');
}

/* 查词: 英文按 完全匹配 > 前缀 > 包含 排序; 含中文时按释义搜 */
const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  const box = document.getElementById('search-result');
  if (!q) { box.innerHTML = ''; return; }
  let hits;
  if (/[一-鿿]/.test(q)) {
    hits = STUDY_ORDER.filter(w => (w.t || '').includes(q));
  } else {
    const rank = w => w.w === q ? 0 : w.w.startsWith(q) ? 1 : w.w.includes(q) ? 2 : -1;
    hits = WORDS.filter(w => rank(w) >= 0)
      .sort((a, b) => (rank(a) - rank(b)) || (a.w.length - b.w.length) || (a.w < b.w ? -1 : 1));
  }
  box.innerHTML = hits.slice(0, 10).map(w =>
    '<div class="sr-item"><div class="sr-word">' + escapeHtml(w.w) +
    (w.ph ? '<span class="sr-ph">/' + escapeHtml(w.ph) + '/</span>' : '') +
    '<span class="tag tag-' + w.imp + '">' + TAG_NAMES[w.imp] + '</span></div>' +
    '<div class="sr-def">' + escapeHtml(w.t) + '</div>' +
    (w.r ? '<div class="sr-root">' + escapeHtml(w.r.replace(/\s*->\s*/g, ' → ')) + '</div>' : '') + '</div>'
  ).join('') || '<div class="sr-empty">未找到相关单词</div>';
});

/* ================= 启动 ================= */
rollDaily();
nav('home');
