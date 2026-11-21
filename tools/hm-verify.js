// hermes-verify: 用最小 DOM shim + 真网关，跑改动过的三段逻辑 (/#4 #6 #8)
const fs = require('fs'), vm = require('vm'), path = require('path');
const PAGE = process.argv[2], MODE = process.argv[3] || 'main', BASE = process.env.HM_BASE || 'http://localhost:9119';
// 口令来源顺序：HM_PASS 环境变量 → keys/dashboard.pass。仓库里一个字节都不存。
const PASS = (() => {
  if (process.env.HM_PASS) return process.env.HM_PASS;
  try {
    return require('fs').readFileSync(
      require('path').join(process.env.LOCALAPPDATA || '', 'hermes', 'keys', 'dashboard.pass'),
      'utf8').trim();
  } catch (e) { return ''; }
})();
const t0 = Date.now(), tag = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond, extra]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A dying harness must say so: an uncaught async error used to kill the process
// silently, so verify_all reported "5/6" with every visible line PASS.
const die = e => { console.log('FAIL harness 崩了: ' + ((e && (e.stack || e.message)) || e)); process.exit(1); };
process.on('unhandledRejection', die);
process.on('uncaughtException', die);

/* ---------- DOM shim ---------- */
const els = new Map();
function el(sel) {
  const e = {
    _sel: sel, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', className: '',
    files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, children: [], listeners: {},
    classList: { _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, v) { (v === undefined ? !this._s.has(c) : v) ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    removeEventListener() {}, prepend(c) { this.children.unshift(c); return c; },
    remove() {}, setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    requestSubmit() { (this.listeners.submit || []).forEach(f => f({ preventDefault() {} })); },
    // 增量翻页要真的 insertBefore/insert 一个 DocumentFragment（真 DOM 里 fragment
    // 被插入时是「把子节点摊开」，这里照同一语义实现，否则测不出节点有没有被推倒重来）
    get parentNode() { return this._parent || null; },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() {
      const p = this._parent;
      if (!p || !p.children) return null;
      const i = p.children.indexOf(this);
      return i < 0 ? null : (p.children[i + 1] || null);
    },
    appendChild(c) {
      if (c && c._frag) { (c.children || []).forEach(x => { x._parent = this; this.children.push(x); }); c.children = []; return c; }
      if (c) c._parent = this;
      this.children.push(c);
      return c;
    },
    insertBefore(node, ref) {
      const kids = (node && node._frag) ? node.children.slice() : [node];
      if (node && node._frag) node.children = [];
      let at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) at = this.children.length;
      for (const k of kids) { if (k) { k._parent = this; this.children.splice(at++, 0, k); } }
      return node;
    },
    replaceChild(nw, old) {
      const i = this.children.indexOf(old);
      if (i < 0) return old;
      const kids = (nw && nw._frag) ? nw.children.slice() : [nw];
      if (nw && nw._frag) nw.children = [];
      this.children.splice(i, 1, ...kids.filter(Boolean));
      kids.forEach(k => { if (k) k._parent = this; });
      if (old) old._parent = null;
      return old;
    },
    removeChild(node) {
      const i = this.children.indexOf(node);
      if (i >= 0) this.children.splice(i, 1);
      if (node) node._parent = null;
      return node;
    },
  };
  // innerHTML = '' 在真 DOM 里会把子节点清空；页面靠这一句重画整表。
  let _html = '';
  Object.defineProperty(e, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); if (_html === '') e.children.length = 0; },
    configurable: true,
  });
  return e;
}
const qs = sel => { if (!els.has(sel)) els.set(sel, el(sel)); return els.get(sel); };
globalThis.document = {
  hidden: false, querySelector: qs, getElementById: id => qs('#' + id), createElement: t => el(t),
  createDocumentFragment: () => { const f = el('#frag'); f._frag = true; return f; },
  body: el('body'), addEventListener(t, f) { (this._l ||= {})[t] = (this._l[t] || []).concat(f); },
  documentElement: el('html'),
};
globalThis.window = globalThis;
// 页面是浏览器代码，window 上一定有 addEventListener；这里是 Node，shim 得补上，
// 否则任何 `window.addEventListener(...)`（pagehide / resize 之类）都会在引导阶段抛。
if (typeof globalThis.addEventListener !== 'function') {
  globalThis.addEventListener = (t, f) => { (globalThis._wl ||= {})[t] = (globalThis._wl[t] || []).concat(f); };
  globalThis.removeEventListener = () => {};
}
globalThis.location = { protocol: 'http:', host: 'localhost:9119', href: BASE + '/' };
globalThis.navigator = { vibrate() {}, clipboard: undefined, userAgent: 'verify' };
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
// node 里没有 IndexedDB，而页面用它做「会话历史本地缓存」。给一个内存版，只实现页面
// 真正调用的那几个方法；请求回调排在下一轮 tick，事务完成排在请求之后 —— 和真
// IndexedDB 的时序同构，页面那段 open/tx 逻辑才测得到。
globalThis.indexedDB = (() => {
  const dbs = new Map();
  const req = run => {
    const r = {};
    setTimeout(() => {
      try { r.result = run(); r.onsuccess && r.onsuccess(); }
      catch (e) { r.error = e; r.onerror && r.onerror(); }
    }, 0);
    return r;
  };
  return {
    open(name) {
      const r = {};
      setTimeout(() => {
        if (!dbs.has(name)) dbs.set(name, new Map());
        const store = dbs.get(name);
        r.result = {
          objectStoreNames: { contains: () => false },
          createObjectStore() {},
          transaction() {
            const tx = {};
            const api = {
              get: k => req(() => store.get(k)),
              put: (v, k) => req(() => { store.set(k, v); return k; }),
              delete: k => req(() => { store.delete(k); return 1; }),
              getAllKeys: () => req(() => Array.from(store.keys())),
            };
            tx.objectStore = () => api;
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 5);
            return tx;
          },
        };
        r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      }, 0);
      return r;
    },
  };
})();
globalThis.requestAnimationFrame = fn => setTimeout(fn, 16);
globalThis.confirm = () => true; globalThis.alert = () => {};
// node 没有 FileReader；用 fs 模拟浏览器那一个方法就够——页面在真实浏览器里
// 走的是同一个 onload(dataURL) 契约。
globalThis.FileReader = class {
  readAsDataURL(f) {
    const buf = Buffer.from(f.__bytes || new Uint8Array(0));
    const mime = f.type || 'application/octet-stream';
    setTimeout(() => { this.result = 'data:' + mime + ';base64,' + buf.toString('base64'); this.onload && this.onload(); }, 0);
  }
};
const fireVisibility = () => (document._l && document._l.visibilitychange || []).forEach(f => f());

/* ---------- fetch: 补 base + cookie，模式化打桩 ---------- */
let COOKIE = '', loginDone = false, fake401 = 0, failMe = 0, failTicket = 0, hangTicket = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  const raw = String(u);
  const url = raw.startsWith('http') ? raw : BASE + (raw.startsWith('/') ? '' : '/') + raw;
  // 更新检查：真实网关要登录才给，这里直接喂一个更高版本，验「会不会提示」
  if (url.endsWith('/version.json')) {
    return new Response(JSON.stringify({ code: 99, name: '9.9' }),
                        { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (failMe > 0 && url.includes('/api/auth/me')) { failMe--; throw new TypeError('fetch failed'); }
  // 瞬时网络错误要打在 ws-ticket 上：/api/auth/me 的异常被 authed() 吞成 null，
  // 走的是「弹登录框 + 自动登录」那条路，绕开了 scheduleReconnect —— 测不到 #9。
  if (failTicket > 0 && url.includes('/api/auth/ws-ticket')) { failTicket--; throw new TypeError('fetch failed'); }
  // 挂住不返回：模拟弱网 / 地址黑洞。真 fetch 会尊重 signal，这里照做 ——
  // 不然「有超时」和「没超时」在打桩下没区别，等于没测。
  if (hangTicket > 0 && url.includes('/api/auth/ws-ticket')) {
    hangTicket--;
    return new Promise((_, rej) => {
      const sig = o && o.signal;
      if (sig) sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
  }
  const sendCookie = url.includes('/api/auth/me') ? loginDone : true;
  const headers = { ...(o.headers || {}) };
  if (COOKIE && sendCookie) headers.cookie = COOKIE;
  if (MODE === 'login' && url.endsWith('/auth/password-login') && fake401 < 2) {
    fake401++; console.log(tag(), '打桩：第 ' + fake401 + ' 次登录返回 401');
    return new Response('{}', { status: 401 });
  }
  const r = await realFetch(url, { ...o, headers });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) COOKIE = sc.map(c => c.split(';')[0]).join('; ');
  if (url.endsWith('/auth/password-login') && r.ok) loginDone = true;
  return r;
};

/* ---------- WebSocket: 计数 + 记外发帧 ---------- */
// Node 20 没有全局 WebSocket（21 才加，22 才稳定）。CI 是 20，缺了不能直接
// `class extends undefined`；拿一个只记账、不真发包的桩顶上，断言看的是页面
// 自己的状态机，不看连接有没有真的建立。
const sockets = [];
const RealWS = globalThis.WebSocket;
const WSBase = RealWS || class {
  constructor(u) { this.url = u; this.readyState = 0; }
  send() {} close() { this.readyState = 3; }
  addEventListener() {} removeEventListener() {}
};
globalThis.WebSocket = class extends WSBase {
  constructor(u, p) { super(u, p); this._sent = []; sockets.push(this); }
  send(d) { try { this._sent.push(Object.assign(JSON.parse(d), { __t: Date.now() })); } catch (e) {}
            return super.send(d); }
};

/* ---------- 跑页面脚本 ---------- */
// 假装自己跑在 APK 壳里（MainActivity 注入的就是这个对象），这样 SHELL 有值，
// checkUpdate 才会真的去比版本。浏览器里打开时它是 undefined —— 页面必须静默跳过。
globalThis.HermesApp = { version: () => JSON.stringify({ code: 1, name: '1.0' }) };
// 壳会先把账号密码填进登录框（MainActivity.fillLogin 干的就是这件事）。页面里已经
// 不再内置口令了，验证要照着壳的行为先把表单填好，否则自动登录永远拿空密码去撞。
if (PASS) { qs('#lu').value = process.env.HM_USER || 'hermes'; qs('#lp').value = PASS; }
const src = fs.readFileSync(PAGE, 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
try { vm.runInThisContext(src, { filename: 'page.js' }); }
catch (e) { console.log('BOOT THREW:', e.message); process.exit(1); }

const S = () => globalThis.__hm.state();
const sent = (name, since) => sockets.reduce((n, s) =>
  n + s._sent.filter(f => f.method === name && (!since || f.__t >= since)).length, 0);

/* ---------- 主测试 ---------- */
(async () => {
  if (MODE === 'login') {
    let maxTries = 0, up = false;
    for (let i = 0; i < 120; i++) {                       // 最多等 18s
      const st = S(); maxTries = Math.max(maxTries, st.loginTries);
      if (st.connected) { up = true; break; }
      await sleep(300);
    }
    ok('#8 自动登录失败后仍在重试（loginTries 递增）', maxTries >= 3, 'max loginTries=' + maxTries);
    ok('#8 两次 401 之后最终连上', up, 'connected=' + S().connected);
    return finish();
  }

  // 真登录一次，拿 cookie。口令不在仓库里：优先环境变量（对着旧部署跑时用），
  // 否则读 start.cmd 生成的那份 %LOCALAPPDATA%\hermes\keys\dashboard.pass。
  const lr = await realFetch(BASE + '/auth/password-login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', username: process.env.HM_USER || 'hermes', password: PASS }) });
  COOKIE = (lr.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  loginDone = true;

  let st = {};
  for (let i = 0; i < 40; i++) { st = S(); if (st.connected) break; await sleep(250); }
  ok('#4 页面脚本在 shim 下能启动并连上 WS', st.connected, JSON.stringify(st));
  // session.list 在 openWs 之后才回来，而且要扫 8 万条消息，网关忙的时候十几秒。
  // 等结果，但别用固定 sleep 赌它快 —— 之前赌 1.5s，网关一慢就假红。
  for (let i = 0; i < 60 && !(st.sessions > 0); i++) { await sleep(500); st = S(); }
  ok('#6 启动时拉到会话列表', (st.sessions || 0) > 0, 'sessions=' + st.sessions);

  // #6：第二个客户端（扮桌面端）改一行 state.db → 页面应收到 sessions.changed 并自拉列表
  //   socket 的 error/close 是异步的，try/catch 接不住：显式吞掉 + 超时兜底 +
  //   一次重试（ws-ticket 偶发抢不到，重试即过）。
  const probeArchive = () => new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; clearTimeout(guard); resolve(v); } };
    const guard = setTimeout(() => done(null), 40000);   // session.list 慢的时候要等它跑完补跑那一轮
    fetch('/api/auth/ws-ticket', { method: 'POST' })
      .then(r => r.json())
      .then(j => {
        if (!j || !j.ticket) return done(null);
        const w2 = new RealWS('ws://localhost:9119/api/ws?ticket=' + j.ticket);
        w2.onerror = () => done(null);
        w2.onclose = () => done(null);
        w2.onopen = async () => {
          const flip = (v, id) => { try { w2.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'session.archive',
            params: { session_id: '20261119_105716_581da4', archived: v } })); } catch (e) {} };
          flip(false, 8);                        // 先归零：保证下一步是真翻转
          await sleep(1200);
          const tMark = Date.now();
          flip(true, 9);
          let hit = 0;
          for (let i = 0; i < 60 && !hit; i++) { await sleep(500); hit = sent('session.list', tMark) ? 1 : 0; }
          flip(false, 10);                       // 还原
          await sleep(600);
          try { w2.close(); } catch (e) {}
          done(hit);
        };
      })
      .catch(() => done(null));
  });
  let hits = null;
  for (let a = 0; a < 2 && hits !== 1; a++) hits = await probeArchive();
  ok('#6 sessions.changed → 页面自己发了一次 session.list', hits === 1,
     hits === null ? '第二个 WS 没连上（重试后仍失败）' : '页面收到并自拉=' + hits);

  // #4：拔掉入站帧（真僵尸就是这样：对端不吭声）+ 把 lastFrameAt 推老化，
  //     看门狗应在下一跳（≤15s）拆掉并重连
  const before = sockets.length;
  const wsPage = sockets[sockets.length - 1], origMsg = wsPage.onmessage;
  let mute = true;
  wsPage.onmessage = ev => { if (!mute) origMsg(ev); };
  globalThis.__hm.goStale();
  let revived = false;
  for (let i = 0; i < 90; i++) {                        // ≤ 22s
    if (sockets.length > before && S().connected) { revived = true; break; }
    await sleep(250);
  }
  mute = false;
  ok('#4 lastFrameAt 过期 → 关旧 socket 且新 socket 建起并连上', revived,
     'sockets ' + before + '→' + sockets.length + ', connected=' + S().connected);

  // #4b：回前台应触发一次静默对账（等重连真正就绪再切前台，否则测的是时序不是逻辑）
  for (let i = 0; i < 40 && !S().connected; i++) await sleep(200);
  const tVis = Date.now(); document.hidden = false; fireVisibility();
  let vis = 0;
  for (let i = 0; i < 80 && !vis; i++) { await sleep(300); vis = sent('session.list', tVis); }
  ok('#4b visibilitychange 回前台 → 发一次 session.list', vis >= 1, '次数=' + vis);

  // #9：断线 + 一次瞬时网络错误 —— 必须排上重试并自愈，不能停在登录框。
  // 别拿 reconnTries 断言（连上就归零，读到的是成功后状态），改看只增不减的
  // reconnCalls：先取「drop 之后已经排过几次」，再要求 kick 造成的那次失败
  // 又把它推高一次 —— 这才是 #9 的修复本身。
  failTicket = 1; globalThis.__hm.drop();
  await sleep(300);
  const callsAfterDrop = globalThis.__hm.retry().calls;
  globalThis.__hm.kick();
  let callsNow = callsAfterDrop;
  for (let i = 0; i < 30; i++) {
    callsNow = globalThis.__hm.retry().calls;
    if (callsNow > callsAfterDrop) break;
    await sleep(100);
  }
  ok('#9 瞬时 fetch 失败 → 又排了一次重试（不停摆）', callsNow > callsAfterDrop,
     'calls ' + callsAfterDrop + '→' + callsNow);
  let healed = false;
  for (let i = 0; i < 40; i++) { if (S().connected) { healed = true; break; } await sleep(250); }
  ok('#9 之后自己连回来', healed, 'connected=' + S().connected);

  // #11 附件引用必须拼在正文最前面（模型靠它找到文件）。
  //     纯函数验证 —— 验证脚本绝不调用 prompt.submit：页面启动会自动打开最近的真实
  //     会话，一发就是往用户的对话里塞消息（之前就这么污染过几次）。
  globalThis.__hm.fakeFile('a.pdf', '@file:C:\\tmp\\a.pdf');
  const ptext = globalThis.__hm.payload('看看这个');
  ok('#11 附件引用前置进正文', ptext === '@file:C:\\tmp\\a.pdf\n看看这个',
     JSON.stringify(ptext.slice(0, 60)));
  globalThis.__hm.clearAttaches();
  ok('#11 清掉附件后正文回到原文', globalThis.__hm.payload('你好') === '你好' && S().files === 0,
     'files=' + S().files);

  // #12 真字节走一遍 attachFile：页面自己的 FileReader → base64 → file.attach → 网关落盘
  //     （#11 是塞的假 ref，只验拼装；这里验上传本身）
  const payload = Buffer.from('xlsx 假装二进制 ' + Date.now() + '\n', 'utf8');
  const fakeFile = new File([payload], '报表.xlsx', { type: 'application/vnd.ms-excel' });
  fakeFile.__bytes = payload;
  await globalThis.__hm.attachFile(fakeFile);
  await sleep(600);
  ok('#12 真字节 file.attach 成功（附件条 1 个）', S().files === 1, 'files=' + S().files);

  // #13 fetch 挂住不返回（弱网 / 地址黑洞）时，connect() 必须靠超时自己解开。
  //     卡死的话 connecting 永远 true，之后每次点按钮都在第一行被 return —— 「点了没反应」。
  hangTicket = 1;
  globalThis.__hm.drop();
  await sleep(300);
  globalThis.__hm.kick();
  await sleep(1500);
  const stuck = S().connecting;                     // 此刻应当还卡着（10s 才超时）
  let freed = false;
  for (let i = 0; i < 40; i++) { if (!S().connecting) { freed = true; break; } await sleep(500); }
  ok('#13 fetch 挂住 → 超时解开连接锁', stuck && freed,
     'connecting ' + stuck + '→' + S().connecting);
  const callsBefore = globalThis.__hm.retry().calls;
  for (let i = 0; i < 40 && !S().connected; i++) await sleep(250);   // 等它自己连回来再拔
  globalThis.__hm.drop();                           // 解锁之后断线，还得自己排重连
  let again = false;
  for (let i = 0; i < 30; i++) {
    if (globalThis.__hm.retry().calls > callsBefore) { again = true; break; }
    await sleep(200);
  }
  ok('#13 解锁后断线仍会自动重连', again,
     'calls ' + callsBefore + '→' + globalThis.__hm.retry().calls);

  // #14 点「重新连接」必须当场有可见反馈。要点完立刻同步读：等 150ms 的话
  //     重连已经完成、conn 变成「已连接」，读到的是结果不是反馈。
  (qs('#btnRelogin').listeners.click || []).forEach(f => f({ preventDefault() {} }));
  const connNow = qs('#conn').textContent || '';
  ok('#14 点『重新连接』立刻有反馈', /重连|连接/.test(connNow), 'conn=' + JSON.stringify(connNow));

  // #15 红线：验证过程一个 prompt 都不许发。以前 #11 真的 send() 了一发，
  //     消息落进了用户当时打开的会话里 —— 这行断言就是防它再犯。
  const submits = sockets.reduce((n, s) => n + s._sent.filter(f => f.method === 'prompt.submit').length, 0);
  ok('#15 全程没向任何会话提交 prompt', submits === 0, 'prompt.submit 帧=' + submits);

  // #16 壳版本 1 < version.json 里的 99 → 页面必须把更新条露出来，链接指向 APK
  let updShown = false;
  for (let i = 0; i < 20; i++) {
    if (qs('#upd').hidden === false) { updShown = true; break; }
    await sleep(100);
  }
  ok('#16 有新版时露出更新条', updShown, 'hidden=' + qs('#upd').hidden + ' href=' + qs('#upd').href);

  // #17 会话历史缓存：网关的 session.history 不支持分页，839 条的会话一次要拉 866 KB。
  //     第二次点进同一个会话必须先画缓存，而不是干等网络。这里给缓存塞 400 条，
  //     再打开它 —— 网络那半还没回来，副行就该已经是「缓存 … 同步中…」。
  const PROBE = { cache: globalThis.__hm.histCache(), open: globalThis.__hm.openSession };
  ok('#17 页面里有本地历史缓存', !!(PROBE && PROBE.cache), 'HCACHE=' + typeof (PROBE && PROBE.cache));
  const fakeId = 'local-verify-cache';
  const fakeMsgs = [];
  for (let i = 0; i < 400; i++) {
    fakeMsgs.push({ role: i % 2 ? 'assistant' : 'user', text: '缓存消息 ' + i,
                    timestamp: Math.floor(Date.now() / 1000) - 400 + i });
  }
  await PROBE.cache.put(fakeId, fakeMsgs);
  const got = await PROBE.cache.get(fakeId);
  ok('#17 缓存写进去能原样读回来', !!(got && got.msgs.length === 400), 'msgs=' + (got && got.msgs.length));
  const pending = (() => {
    // 记录副行文案的每一次写入 + 数一数这次开了多少 DOM 节点，
    // 用它们证明"缓存先画出来了"，而不是靠 sleep 去赌网络慢。
    const subEl = qs('#ttlSub');
    const subs = [];
    let cur = subEl.textContent;
    Object.defineProperty(subEl, 'textContent', {
      get() { return cur; }, set(v) { cur = v; subs.push(String(v)); }, configurable: true,
    });
    let created = 0;
    const origCreate = document.createElement;
    document.createElement = t => { created++; return origCreate(t); };
    const n0 = created;
    const done = globalThis.__hm.openSession({ id: fakeId, title: '缓存验证' })
      .then(() => { document.createElement = origCreate; });
    return done.then(() => ({ subs, nodes: created - n0 }));
  })();
  const r17 = await pending;   // 假会话必然 resume 失败，openSession 自己 catch 掉
  const cachedFirst = r17.subs.some(v => /缓存/.test(v));
  const failIdx = r17.subs.findIndex(v => /载入失败/.test(v));
  const cacheIdx = r17.subs.findIndex(v => /缓存/.test(v));
  ok('#17 缓存命中时先渲染、不等网络',
     cachedFirst && r17.nodes >= 100 && (failIdx < 0 || cacheIdx < failIdx),
     '节点=' + r17.nodes + ' 副行=' + JSON.stringify(r17.subs));

  // #18 历史翻页：以前 slice(-160) 把更早的直接扔掉，数据其实整份在内存里。
  //     现在默认画 160 条，点一次「加载更早」往前 160，能一路翻到第一条。
  const H = globalThis.__hm;
  const many = [];
  for (let i = 0; i < 400; i++)
    many.push({ role: i % 2 ? 'assistant' : 'user', text: '第 ' + i + ' 条消息', timestamp: 1700000000 + i * 60 });
  H.renderHistory(many);
  const h0 = H.histState();
  const h1 = H.expandOlder();
  const h2 = H.histState();
  const h3 = H.expandOlder();
  ok('#18 更早的历史能翻出来（不只是一句已折叠）',
     h0.all === 400 && h0.shown === 160 && h0.more && h1 === 320 && h2.more && h3 === 480,
     'all=' + h0.all + ' shown ' + h0.shown + '→' + h1 + '→' + h3 + ' more=' + h0.more + '/' + h2.more);

  // #19 条数信号没变就跳过全量 history（839 条的会话 1 MB / 十几秒）
  const g1 = H.cacheHitFor({ n: 50 }, { message_count: 50 });          // 命中
  const g2 = H.cacheHitFor({ n: 50 }, { message_count: 51 });          // 多了消息 → 必须拉
  const g3 = H.cacheHitFor({ msgs: [1], t: 1 }, { message_count: 50 }); // 老缓存没 n → 不命中
  const g4 = H.cacheHitFor({ n: 0 }, { message_count: 0 });            // 空会话 → 不命中
  ok('#19 条数没变就跳过全量拉取', g1 && !g2 && !g3 && !g4,
     'same=' + g1 + ' changed=' + g2 + ' legacy=' + g3 + ' empty=' + g4);

  // #20 长回答走 120 ms 节流，但最后一帧必须落地（不能只画一帧就停）
  H.streamAppend('x'.repeat(9000));
  const pending0 = H.streamState();
  await sleep(200);
  const painted = H.streamState();
  ok('#20 长回答节流渲染且尾帧不丢',
     !!pending0 && pending0.len === 9000 && pending0.html < 100 && painted.html > 8000,
     '刚追加 html=' + (pending0 && pending0.html) + '（只有光标占位）→ 200ms 后 html=' + (painted && painted.html));

  // #21 一轮聊完要「续命」缓存：只靠 pullHistory 写缓存的话，手机上聊一轮就等于
  //     把这份缓存作废（服务端 message_count 变了、缓存的 n 没变），下次又拉 150–500 KB。
  //     这里走真实路径：给出真实会话 id → 画一段历史 → rememberTurn 收尾 → 等防抖落地。
  //     先等历史通道彻底安静：开机/重连那几次全量 history 在真实网关（182 条的会话）
  //     上能跑一两秒，晚到一次就会把 histAll 整个换掉（这是正确行为，产品没错），
  //     但它会跟这条断言抢跑。用页面的 histPullCount 判「还有没有在飞的全量」。
  let lastPulls = H.histPulls(), quiet = 0;
  for (let i = 0; i < 20 && quiet < 2; i++) {
    await sleep(900);
    const p = H.histPulls();
    quiet = (p === lastPulls) ? quiet + 1 : 0;
    lastPulls = p;
  }
  // 把「收尾→写缓存」的延迟压到 60ms：真实默认 2600ms 是等列表刷新，测试里窗口越小
  // 越不会被中途落地的一次全量补拉撞掉（上一版 3.2s 窗口偶发 flaky）。
  H.setCacheSyncMs(60);
  const rr = H.realRow();
  const synth = [];
  for (let i = 0; i < 200; i++)
    synth.push({ role: i % 2 ? 'assistant' : 'user', text: '旧消息 ' + i, timestamp: 1700000000 + i * 60 });
  // 一次「聊完一轮」的全流程：画出历史 → 收尾 → 等防抖落地
  async function turnRound() {
    H.useStored(rr.id);
    H.renderHistory(synth);
    H.rememberTurn('这一轮的问题', '这一轮的回答', false);
    await sleep(350);
    const after = await H.histCache().get(rr.id);
    const tail = after && after.msgs ? after.msgs.slice(-2) : [];
    return { after, tail,
             ok: !!(after && after.n === rr.message_count && tail.length === 2 &&
                    tail[0].text === '这一轮的问题' && tail[1].text === '这一轮的回答') };
  }
  let r21 = { ok: false, after: null, tail: [] }, why21 = 'no real row';
  if (rr) {
    const before = await H.histCache().get(rr.id);
    r21 = await turnRound();
    // 撞上一次晚到的全量补拉就再走一遍：补拉覆盖缓存是产品该有的行为，不是缺陷
    if (!r21.ok) r21 = await turnRound();
    why21 = 'n=' + (r21.after && r21.after.n) + '/' + rr.message_count +
            ' 尾两条=' + JSON.stringify(r21.tail.map(m => m.text)) +
            ' 前值=' + (before && before.n) + ' pulls=' + H.histPulls();
  }
  ok('#21 聊完一轮续命缓存（下一轮不必再拉全量）', r21.ok, why21);

  // #22 图片附件无法本地拼（@image:<path> 由服务端补）→ 宁可让缓存作废，也别把缺图的版本当命中
  let r22 = false, why22 = 'no real row';
  if (rr) {
    const b1 = await H.histCache().get(rr.id);
    H.rememberTurn('带图的问题', '带图的回答', true);
    await sleep(350);
    const b2 = await H.histCache().get(rr.id);
    r22 = !!(b1 && b2 && b1.n === b2.n && b1.msgs.length === b2.msgs.length &&
             b2.msgs[b2.msgs.length - 1].text !== '带图的回答');
    why22 = 'n ' + (b1 && b1.n) + '→' + (b2 && b2.n) + ' 条数 ' + (b1 && b1.msgs.length) + '→' + (b2 && b2.msgs.length);
  }
  ok('#22 带图的一轮不写缓存（缺图不能当命中）', r22, why22);
  H.setCacheSyncMs(2600);   // 恢复真实默认值，后面的测试不要再改

  // #23 历史图片走鉴权路由：以前是 /assets/img/<basename>（dashboard_auth 免鉴权，公网可枚举，
  //     而且新图要重启 link_images 才可见）。现在必须是 /api/fs/download?path=<绝对路径>。
  const abs = 'C:\\Users\\x\\AppData\\Roaming\\Hermes\\composer-images\\a.png';
  const tAbs = H.imgTag(abs), tRel = H.imgTag('a.png');
  ok('#23 图片走 /api/fs/download（不再靠免鉴权的 assets/img）',
     /\/api\/fs\/download\?path=/.test(tAbs) && !/assets\/img/.test(tAbs) && /imgmiss/.test(tRel),
     tAbs.slice(0, 90));

  // #24 翻页是增量的：已经画出来的节点必须原地不动（以前是清空整表重画 480 个气泡）
  H.renderHistory(many);
  const d0 = H.histDom();
  const oldestRow = H.histFirstBubble();
  H.expandOlder();
  const d1 = H.histDom();
  ok('#24 翻页只插入新节点，不重画整表',
     !!oldestRow && H.hasNode(oldestRow) && d1.nodes > d0.nodes && d1.paintedFrom === 240 - 160,
     '节点 ' + d0.nodes + '→' + d1.nodes + ' paintedFrom=' + d1.paintedFrom);

  // #25 同会话补拉保留翻开的深度；换会话回到 160
  H.renderHistory(many);              // 160
  H.expandOlder();                    // 320
  H.renderHistory(many, true);        // 同会话补拉 → 仍是 320
  const kept = H.histState().shown;
  H.renderHistory(many, false);       // 换会话 → 160
  ok('#25 补拉不缩回 160，换会话才重置', kept === 320 && H.histState().shown === 160,
     '补拉后=' + kept + ' 换会话后=' + H.histState().shown);

  // #26 上传上限 25 MB → 10 MB：dataURL(+33%) 再进一帧 JSON，峰值 2.7 倍，25 MB 要吃 67 MB 堆
  ok('#26 上传上限降到 10 MB', H.fileMax() === 10 * 1024 * 1024, 'FILE_MAX=' + H.fileMax());

  // #27 抽屉不再插日期分组标题（行里没有 updated_at，拿 started_at 分组和「最近活动序」对不上）。
  //     先真画一次列表：开机那次列表是空的，refreshSessions 只在抽屉打开时才重绘，
  //     不主动画一次的话这条断言就是在空数组上白过。
  H.renderList();
  const ld = H.listDom();
  ok('#27 会话列表不再按 started_at 分组', ld.total > 0 && ld.grps === 0,
     '列表节点=' + ld.total + ' 分组标题=' + ld.grps);

  // #28 图片尺寸记忆：第一次加载完记住 naturalWidth/Height，下次渲染直接写进 width/height，
  //     浏览器按比例预留空间。实测 20 张图不带尺寸时页面总高 1718 → 2627（+909px），
  //     带上尺寸之后第二轮的「渲染即高度」与「全部加载完」完全相等（jump=0）。
  const P28 = 'C:\\tmp\\dim-probe.png';
  H.imgDimClear();
  const bare28 = H.imgTag(P28);
  H.imgDimSet(P28, 615, 90);
  const sized28 = H.imgTag(P28);
  ok('#28 记住尺寸后 imgTag 带 width/height（没记就不带）',
     !/width=/.test(bare28) && /width="615"/.test(sized28) && /height="90"/.test(sized28),
     'before=' + bare28.slice(0, 40) + ' after=' + sized28.slice(0, 52));

  // #29 markdown 四条：裸 URL / 任务列表 / 有序起始号 / md 链接不被裸 URL 规则吃掉。
  //     模型常直接吐地址、写 "- [ ]" 计划、从 5. 开始编号，这三条以前都是原样漏出来的。
  const url29 = H.md('看 https://example.com/a?b=1 。尾巴：https://example.com/c)');
  const task29 = H.md('- [ ] 做\n- [x] 完了');
  const ol29 = H.md('5. 五\n6. 六');
  const mix29 = H.md('[标题](https://example.com/x) 与 https://example.com/y');
  ok('#29 裸 URL 变链接且不吃尾部标点',
     /<a href="https:\/\/example\.com\/a\?b=1"/.test(url29) && /<a href="https:\/\/example\.com\/c"/.test(url29)
     && !/\?b=1。/.test(url29),
     url29.slice(0, 90));
  ok('#29 任务列表 / 有序起始号',
     /li class="task"/.test(task29) && /li class="task done"/.test(task29) && !/\[ \]/.test(task29)
     && /<ol start="5">/.test(ol29),
     'task=' + /li class="task"/.test(task29) + ' ol=' + /start="5"/.test(ol29));
  // #30 断线收尾 / 三级嵌套 / 表格最小列宽。
  //     断线时若 S.cur/S.streaming 不清，send() 第一行静默 return，重连后也发不出去。
  const nest30 = H.md('- a\n  - b\n    - c');
  H.streamAppend('半截的回答');
  const before30 = H.streamState();
  H.abortStream('连接中断');
  const after30 = H.streamState();
  ok('#30 断线把半截气泡收尾（S.cur 归零）',
     !!(before30 && before30.len > 0) && !after30,
     'before=' + JSON.stringify(before30) + ' after=' + JSON.stringify(after30));
  ok('#30 三级嵌套有 sub2', /class="sub sub2"/.test(nest30), nest30.slice(0, 90));

  ok('#29 md 链接与裸 URL 共存、不嵌套',
     (mix29.match(/<a /g) || []).length === 2 && !/\u0000L/.test(mix29),
     mix29.slice(0, 120));

  // #31 走查（真浏览器 390×844）抓到的三条 md / 样式问题。
  //     ① 裸 URL 用 [^\s<>"'`] 吃字符，中文紧贴地址时被整段吞进 href
  //        （「…?b=1&c=2，完」实测 href 里带「，完」，点开 404，后面那截字还成了链接）；
  //     ② 尾部英文句号没剥（「https://a.com/path.」href 带句号）；
  //     ③ 缩进只有 sub/sub2 两档，三层以上的列表全塌成同一缩进（4/6/8/12 空都是 32px）。
  const u31a = H.md('见 https://a.com/a?b=1&c=2，完');
  const u31b = H.md('见 https://a.com/path. 完');
  const u31c = H.md('见 https://en.wikipedia.org/wiki/Foo_(bar) 完');
  const n31 = H.md(['- a', '  - b', '    - c', '        - d'].join('\n'));
  ok('#31 裸 URL 不吞中文、不吞英文句号、括号配对',
     /href="https:\/\/a\.com\/a\?b=1&amp;c=2"/.test(u31a) && /<\/a>，完/.test(u31a)
     && /href="https:\/\/a\.com\/path"/.test(u31b) && /<\/a>\. 完/.test(u31b)
     && /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/.test(u31c),
     'a=' + u31a.slice(0, 70) + ' | b=' + u31b.slice(0, 60));
  ok('#31 列表第三层是 sub3（不是塌成 sub2）',
     /class="sub"/.test(n31) && /class="sub sub2"/.test(n31) && /class="sub sub2 sub3"/.test(n31),
     n31.slice(0, 120));

  // #32 走查（真浏览器）抓到的两条事件处理问题：
  //   ① 网关发 error 时只改了两个标志位，S.cur 里的半截气泡还挂着，下一轮 message.start
  //      拿到的还是同一个气泡 → 新回答直接拼进上一轮那半截（实测会连成「半截第二轮」）；
  //   ② 过滤条件里带 S.sid：S.sid 没落时任何会话的帧都放行 → 后台 cron / 电脑端在跑的
  //      那条会把内容流进这块屏幕。
  const sid32 = 'sid-under-test';
  H.useSid(sid32);
  H.renderHistory([], false);
  const r0 = H.histDom().nodes;
  H.event({ type: 'message.start', session_id: sid32 });
  H.event({ type: 'message.delta', session_id: sid32, payload: { text: '半截' } });
  const afterErr = H.event({ type: 'error', session_id: sid32, payload: { message: '模型爆了' } });
  H.event({ type: 'message.start', session_id: sid32 });
  H.event({ type: 'message.delta', session_id: sid32, payload: { text: '第二轮' } });
  const afterTurn = H.event({ type: 'message.complete', session_id: sid32, payload: { text: '第二轮' } });
  const twoRows = H.histDom().nodes - r0;
  const foreignBefore = H.histDom().nodes;
  H.event({ type: 'message.delta', session_id: 'someone-else', payload: { text: '别人的回答' } });
  const foreignAfter = H.histDom().nodes;
  ok('#32 出错后收尾半截气泡（下一轮另起一行，不拼进去）',
     afterErr.cur === false && afterErr.streaming === false && twoRows === 2,
     JSON.stringify({ afterErr, afterTurn, rows: twoRows }));
  ok('#32 别的会话的帧不画到当前屏幕', foreignAfter === foreignBefore,
     'before=' + foreignBefore + ' after=' + foreignAfter);

  finish();
})().catch(e => { console.log('HARNESS THREW:', e.stack); process.exit(1); });

function finish() {
  const bad = results.filter(r => !r[1]).length;
  console.log('\n== ' + (results.length - bad) + '/' + results.length + ' 通过 ==');
  process.exit(bad ? 1 : 0);
}
