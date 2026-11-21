#!/usr/bin/env node
// CI 跑的那一档：不碰网关、不碰 Android SDK、不碰本机地址，纯静态。
//
//   node tools/verify_static.js          # 全部
//   node tools/verify_static.js --md     # 只跑 md() 11 项（verify_all.py 会这么调）
//
// 为什么要单独一个文件：`npm test` 的 harness 会真的连 http://localhost:9119
// 拉会话、登录、发帧，GitHub runner 上没有网关，那边只能跑到静态这一档。
// 本地的全量检查还是 `npm run verify`（tools/verify_all.py），它会把本文件
// 的 --md 档嵌进去跑一遍，所以 md 的断言只有这一份。
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MD_ONLY = process.argv.includes('--md');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const results = [];
const ok = (name, cond, extra) => {
  results.push([name, !!cond]);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};

/* ---------- 1. 内嵌脚本语法 ---------- */
const src = (() => {
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  if (!m) { console.log('FAIL 找不到 <script> 段'); process.exit(1); }
  return m[1];
})();
if (!MD_ONLY) {
  let err = '';
  try { new vm.Script(src); } catch (e) { err = e.message; }
  ok('index.html 脚本语法', !err, err);
}

/* ---------- 2. md() 的 11 项行为 ----------
   从页面里把 md 及其三个依赖原样抠出来，在 vm 里跑，不执行其余脚本。 */
function grabFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return '';
}
function grabLine(prefix) {
  const i = src.indexOf(prefix);
  if (i < 0) return '';
  const j = src.indexOf('\n', i);
  return src.slice(i, j < 0 ? undefined : j);
}
const mod = [
  grabLine('const esc = s =>'),
  grabLine('const IMG_EXT'),
  grabFn('imgBase'), grabFn('imgTag'), grabFn('md'),
].join('\n');

if (!mod.includes('function md(')) {
  ok('md() 可提取', false, '页面里找不到 function md(');
  summary();
}
const ctx = {};
vm.createContext(ctx);
try { vm.runInContext(mod.replace(/^const /gm, 'var '), ctx); } catch (e) {
  ok('md() 可提取', false, e.message);
  summary();
}
const md = ctx.md;
const cases = [];
const has = (name, inp, want, bad) => {
  let out = '';
  try { out = md(inp); } catch (e) { out = 'THREW ' + e.message; }
  const good = typeof out === 'string' && out.includes(want) && (!bad || !out.includes(bad));
  cases.push([name, good, out.replace(/\n/g, '\\n').slice(0, 90)]);
};
has('有序列表仍是 <ol>', '1. 一\n2. 二', '<ol>', '<ul><li>一');
has('无序列表是 <ul>', '- a\n- b', '<ul>', '<ol>');
has('嵌套缩进有 class=sub', '- a\n  - b', 'class="sub"');
has('多行引用合成一块', '> 一\n> 二', '<blockquote>一<br>二</blockquote>', '<p><blockquote>');
has('表格单元格里的竖线不拆列', '| a | b |\n|---|---|\n| `x | y` | z |', '<td><code>x | y</code></td>');
has('带括号的 URL 不截断', '见 [w](https://e.org/Foo_(bar)) 余', 'Foo_(bar)"');
has('--- 变 hr', '上\n\n---\n\n下', '<hr>');
has('_斜体_', '这是 _i_ 字', '<i>i</i>');
has('~~删除~~', '这是 ~~s~~ 字', '<s>s</s>');
has('标题尾井号被吃掉', '## T ##', '<h2>T</h2>');
has('普通段落仍是 <p>', 'hi', '<p>hi</p>');
has('代码块仍是 pre', '```js\nx\n```', '<pre');
const bad = cases.filter(x => !x[1]);
for (const x of cases) console.log((x[1] ? '  ok   ' : '  BAD  ') + x[0] + (x[1] ? '' : '  → ' + x[2]));
ok('md() 12 项行为', bad.length === 0, bad.length ? bad[0][0] : '');

if (MD_ONLY) summary();

/* ---------- 3. 最容易回归的几条事实 ---------- */
const countOf = s => html.split(s).length - 1;
// want 是数字就要求出现次数精确相等（防漏改），null 表示"至少一处"。
const facts = [
  ['输入框单行不出幽灵滚动条', [['padding:9px 12px', null], ['min-height:41px', null], ['max-height:132px', null]]],
  ['三级嵌套有 sub3', [['.bubble li.sub3{margin-left:48px}', null], ["' sub sub2 sub3'", null]]],
  ['出错时收尾半截气泡', [["abortStream('出错了')", null]]],
  ['事件按 session_id 过滤，但放行全局事件', [["t !== 'sessions.changed' && p.session_id !== S.sid", null]]],
  ['socket 处理器认身份', [['if (S.ws !== ws) return;', 3]]],
  ['上传上限文案跟 FILE_MAX 走', [["'，上限 ' + humanSize(FILE_MAX)", null]]],
  ['裸 URL 只吃 RFC3986 ASCII', [['https?:\\/\\/[A-Za-z0-9\\-._~:\\/?#\\[\\]@!$&\'()*+,;=%]+', null]]],
  ['任意文件附件通路齐全', [['file.attach', null], ['id="filePick"', null], ['pendingFiles', null], ['@file:', null]]],
];
for (const [name, checks] of facts) {
  const bad = checks.filter(([n, want]) => (want === null ? countOf(n) < 1 : countOf(n) !== want));
  ok(name, bad.length === 0,
     bad.length ? bad.map(([n, w]) => `${n.slice(0, 16)}… ${countOf(n)}/${w === null ? '≥1' : w}`).join('; ') : '');
}

summary();

function summary() {
  const pass = results.filter(r => r[1]).length;
  console.log(`\n== ${pass}/${results.length} 通过 ==`);
  process.exit(pass === results.length ? 0 : 1);
}
