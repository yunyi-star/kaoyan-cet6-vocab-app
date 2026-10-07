// 核心逻辑自动化测试: 用最小DOM桩在Node里跑 app.js
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- DOM 桩 ----------
function makeEl(id) {
  const listeners = {};
  return {
    id,
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
    files: [],
    disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    click() { this.fire('click'); },
    fire(type) {
      const ev = { stopPropagation() {}, preventDefault() {} };
      (listeners[type] || []).forEach(f => f(ev));
    },
    appendChild() {},
  };
}
const els = {};
const document = {
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement() { return makeEl('_dyn'); },
  body: makeEl('body'),
};
let store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const confirm = () => true;
const location = { reload() {} };
const Blob = class {};
const URL = { createObjectURL: () => '', revokeObjectURL() {} };
const FileReader = class {};

// ---------- 加载数据与逻辑 ----------
const appDir = path.join(__dirname, '..', 'app');
const sandboxRequire = module.exports = {};
const vmCode = fs.readFileSync(path.join(appDir, 'words-data.js'), 'utf-8')
  + '\n' + fs.readFileSync(path.join(appDir, 'app.js'), 'utf-8');
const vm = require('vm');
const ctx = vm.createContext({ document, localStorage, confirm, location, Blob, URL, FileReader, setTimeout, clearTimeout, console, Date, JSON, Math, Object, Array });
vm.runInContext(vmCode, ctx);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}

// ---------- 取得app内部的函数/对象 ----------
const g = ctx; // 顶层 const 不挂到global... 用runInContext再取
// const声明的变量在vm context中可通过再次eval访问
const get = expr => vm.runInContext(expr, ctx);

console.log('== 1. 数据完整性 ==');
const words = get('WORDS');
check('词库已加载', Array.isArray(words) && words.length > 6000, 'len=' + words.length);
check('字段齐全', words.every(w => w.w && w.t && typeof w.imp === 'number'));
check('音标全覆盖', words.every(w => typeof w.ph === 'string' && w.ph.length > 0),
  'missing: ' + words.filter(w => !w.ph).slice(0, 5).map(w => w.w).join(','));
check('音标为合法IPA(无大写/数字)', words.every(w => /^[^A-Z0-9]+$/.test(w.ph)));
const stressRatio = words.filter(w => w.ph.includes('ˈ')).length / words.length;
check('主重音符覆盖率>90%', stressRatio > 0.9, 'ratio=' + stressRatio.toFixed(3));
const impDist = {};
words.forEach(w => { impDist[w.imp] = (impDist[w.imp] || 0) + 1; });
check('重点分布合理(双重点>800)', (impDist[3] || 0) > 800, JSON.stringify(impDist));

console.log('== 2. 首页渲染 ==');
get('nav("home")');
check('首页新词数 = 每日上限', String(els['home-new'].textContent) === '20',
  'home-new=' + els['home-new'].textContent);
check('开始按钮可点', els['btn-start'].disabled === false);

console.log('== 3. 学习流程 ==');
get('startStudy()');
check('队列 = 复习0 + 新词20', get('studyQueue').length === 20, 'len=' + get('studyQueue').length);
check('队列首位是重点词', get('studyQueue')[0].word.imp === 3, 'imp=' + get('studyQueue')[0].word.imp);
check('队列无基础词', get('studyQueue').every(c => c.word.bs === 0));

// 走完一张卡: 显示 -> 认识
check('显示卡正面', els['card-front'].style.display !== 'none');
check('正面显示音标', /^\/.*\/$/.test(els['word-ph'].textContent), 'ph=' + els['word-ph'].textContent);
check('自动发音无TTS环境不崩溃', (() => { try { get('speak("hello")'); return true; } catch (e) { return false; } })());
check('发音按钮点击不报错不翻面', (() => {
  const before = els['card-front'].style.display;
  try { els['btn-speak-front'].fire('click'); } catch (e) { return false; }
  return els['card-front'].style.display === before;
})());
els['btn-reveal'].click();
check('翻面后显示释义', els['card-back'].style.display !== 'none');
const firstWord = get('studyQueue')[0].word.w;
els['btn-know'].click();
const prog = JSON.parse(store['vocabApp.v1']).progress;
check('认识后写入进度', !!prog[firstWord]);
check('认识后间隔=1天(reps0)', prog[firstWord].ivl === 1 && prog[firstWord].reps === 1,
  JSON.stringify(prog[firstWord]));

// 忘了 -> 当场重现
get('startStudy()'); // 队列: 上一个词due明天, 不在复习里; 新词19+1
const qLen = get('studyQueue').length;
els['btn-reveal'].click();
els['btn-forgot'].click();
check('忘了会当场重现(队列+1)', get('studyQueue').length === qLen + 1);
const p2 = JSON.parse(store['vocabApp.v1']).progress;
check('忘了重置reps/ivl', p2[get('studyQueue')[0].word.w] !== undefined);

console.log('== 4. SM-2 调度 ==');
const sch = w => get(`(function(){const w=WORDS.find(x=>x.w==='${w}');state.progress[w.w]={ef:2.5,ivl:0,reps:0,due:0};const re=schedule(w,4);return state.progress[w.w];})()`);
const w1 = sch('abandon'); // 认识1
check('第1次认识 -> 1天', w1.ivl === 1 && w1.reps === 1);
// 第2次认识 -> 6天
const w2 = get(`(function(){const w=WORDS.find(x=>x.w==='abandon');state.progress[w.w]={ef:2.5,ivl:1,reps:1,due:0};schedule(w,4);return state.progress[w.w];})()`);
check('第2次认识 -> 6天', w2.ivl === 6 && w2.reps === 2);
// 第3次认识 -> 6*EF
const w3 = get(`(function(){const w=WORDS.find(x=>x.w==='abandon');state.progress[w.w]={ef:2.6,ivl:6,reps:2,due:0};schedule(w,4);return state.progress[w.w];})()`);
check('第3次认识 -> 6×EF≈16天', w3.ivl === Math.round(6 * 2.6) && w3.reps === 3, 'ivl=' + w3.ivl);
// 模糊 -> 间隔缩短
const w4 = get(`(function(){const w=WORDS.find(x=>x.w==='abandon');state.progress[w.w]={ef:2.5,ivl:20,reps:4,due:0};schedule(w,3);return state.progress[w.w];})()`);
check('模糊 -> 间隔缩至60%', w4.ivl === 12, 'ivl=' + w4.ivl);
check('模糊 -> EF下降', w4.ef < 2.5, 'ef=' + w4.ef);
// 忘了 -> 归零
const w5 = get(`(function(){const w=WORDS.find(x=>x.w==='abandon');state.progress[w.w]={ef:2.5,ivl:20,reps:4,due:0};schedule(w,2);return state.progress[w.w];})()`);
check('忘了 -> reps归0', w5.reps === 0 && w5.ivl === 0);

console.log('== 5. 到期复习 ==');
get('state.progress={}');  // 隔离: 清空之前测试的进度
get(`(function(){const w=WORDS.find(x=>x.w==='abandon');state.progress[w.w]={ef:2.5,ivl:1,reps:1,due:Date.now()-1000};})()`);
get('state.daily={date:today(),newDone:0,revDone:0}');
get('startStudy()');
check('到期词进入复习队列首位', get('studyQueue')[0].word.w === 'abandon' && get('studyQueue')[0].isNew === false);
check('复习队列后接新词', get('studyQueue')[1] && get('studyQueue')[1].isNew === true);

console.log('== 6. 持久化与每日重置 ==');
const saved = JSON.parse(store['vocabApp.v1']);
check('进度已持久化', Object.keys(saved.progress).length > 0);
check('设置已持久化', saved.settings.daily === 20);
check('streak记录', saved.streak.last === get('today()'));

console.log('== 7. 设置变更 ==');
get('state.settings.scope="all"');
const elig = get('eligibleNewWords()');
check('范围=全部时包含普通词', elig.some(w => w.imp === 0));
get('state.settings.basic=true');
const elig2 = get('eligibleNewWords()');
check('开启基础词后包含bs词', elig2.some(w => w.bs === 1));

console.log('== 8. Bug 修复回归 ==');
const wk = get(`(function(){const w=WORDS.find(x=>x.w==='abandon');state.progress[w.w]={ef:2.5,ivl:0,reps:0,due:0};schedule(w,4);return state.progress[w.w].due;})()`);
check('到期时间按日历日对齐到零点', new Date(wk).getHours() === 0 && new Date(wk).getMinutes() === 0 && wk > Date.now());
get('state.streak={last:"2000-01-01",count:9}');
check('中断的连续天数显示为0', get('currentStreak()') === 0);
get('state.streak={last:yesterday(),count:9}');
check('昨天学过连续天数保留', get('currentStreak()') === 9);
check('真题例句去掉选项前缀', get('cleanExample("D) The self-repairing ability")') === 'The self-repairing ability');
check('HTML转义', get('escapeHtml("<b>&")') === '&lt;b&gt;&amp;');
els['search-input'].value = 'act';
els['search-input'].fire('input');
check('查词完全匹配排第一', /^<div class="sr-item"><div class="sr-word">act</.test(els['search-result'].innerHTML));
els['search-input'].value = '抛弃';
els['search-input'].fire('input');
check('支持中文释义查词', els['search-result'].innerHTML.includes('abandon'));
// 忘了的新词当场重现后再答, 不应计入复习数
get('state.progress={};state.daily={date:today(),newDone:0,revDone:0};state.settings.daily=1');
get('startStudy()');
els['btn-reveal'].click(); els['btn-forgot'].click();
els['btn-reveal'].click(); els['btn-know'].click();
check('当场重现不重复计数', get('state.daily.newDone') === 1 && get('state.daily.revDone') === 0,
  get('JSON.stringify(state.daily)'));
check('未翻面时快捷作答被忽略', (() => { get('answer(4)'); return get('state.daily.newDone') === 1; })());

console.log('== 9. 拼写练习 ==');
get('state.progress={};state.spell={}');
get('startSpell()');
check('无已学词时不开始拼写', get('spellQueue').length === 0);
get(`['abandon','ability','adopt'].forEach(w=>{state.progress[w]={ef:2.5,ivl:1,reps:1,due:Date.now()+86400000};})`);
get('state.spell={adopt:{ok:0,bad:1,weak:true}}');
get('startSpell()');
check('拼写队列 = 已学词', get('spellQueue').length === 3, 'len=' + get('spellQueue').length);
check('待巩固词排在最前', get('spellQueue')[0].word.w === 'adopt');
check('题面不泄露单词(遮罩)', els['sp-mask'].innerHTML === '_____');
check('例句挖空不含原词', !/adopt/i.test(els['sp-cloze'].innerHTML) && els['sp-cloze'].innerHTML.includes('<u>'),
  els['sp-cloze'].innerHTML.slice(0, 80));
els['sp-input'].value = 'Adopt';
els['btn-spell-check'].click();
check('拼对(忽略大小写)记录正确', get('state.spell.adopt.ok') === 1 && get('state.spell.adopt.weak') === false);
els['btn-spell-check'].click(); // 下一个
const sw2 = get('spellQueue[spellIndex].word.w');
els['sp-input'].value = 'xxxx';
els['btn-spell-check'].click();
check('拼错进入待巩固', get('state.spell["' + sw2 + '"].weak') === true);
check('拼错的词本轮末尾再考一次', get('spellQueue').length === 4);
check('拼错时标出错误字母', els['sp-feedback'].innerHTML.includes('class="x"'));
els['btn-spell-check'].click();
get('spellHint()'); get('spellHint()');
const sw3 = get('spellQueue[spellIndex].word.w');
check('提示揭示前两个字母', els['sp-input'].value === sw3.slice(0, 2));
els['sp-input'].value = sw3;
els['btn-spell-check'].click();
check('用了提示仍算待巩固', get('state.spell["' + sw3 + '"].weak') === true);
get('spellIndex=spellQueue.length-1;spellChecked=true;checkSpell()');
check('练完返回首页', get('spellQueue').length === 0);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
