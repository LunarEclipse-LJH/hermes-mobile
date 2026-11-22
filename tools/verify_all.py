#!/usr/bin/env python3
"""Ad-hoc verification for the hermes-mobile changes (not a test suite).

Checks, in order:
  1. index.html  : script syntax + md() behaviour on the cases that were broken
  2. index.html  : live-gateway behaviour harness (socket watchdog / sessions.changed / retry)
  3. apk/        : MainActivity + manifest actually build into a signed APK
  3b. ipv4       : ipv4_bridge.py relay serves HTTP + a WebSocket 101 over 127.0.0.1
  4. address     : refresh_addrs.ps1 writes a valid, reachable addrs.json
  5. launchers   : start.cmd / show_url.cmd keep CRLF, ASCII, and call the ps1
"""
import json, os, re, shutil, subprocess, sys, tempfile, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 仓库根
SCRATCH = HERE                        # hm-verify.js 与本脚本同目录
PY = sys.executable
results = []


def ok(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (("  " + extra) if extra else ""))


def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main(tmp):
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()

    # ---- 1. syntax + md() -------------------------------------------------
    js = os.path.join(tmp, "page.js")
    open(js, "w", encoding="utf-8").write(re.search(r"<script>(.*)</script>", html, re.S).group(1))
    rc, out = run(["node", "--check", js])
    ok("index.html 脚本语法", rc == 0, out.strip()[:120])

    # 任意文件上传：网关侧是 file.attach（data_url 带字节，回 @file:<path>），
    # 页面侧必须三件齐 —— 选文件的 input、发 RPC、把引用拼进正文。
    ok("index.html 有任意文件附件通路",
       all(k in html for k in ("file.attach", "id=\"filePick\"", "pendingFiles", "@file:")),
       "file.attach + filePick + @file: 渲染")

    md_py = os.path.join(tmp, "mk_md.py")
    open(md_py, "w", encoding="utf-8").write(r'''
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
def grab(n):
    i = s.index("function " + n + "("); j = s.index("{", i); d = 0
    for k in range(j, len(s)):
        if s[k] == "{": d += 1
        elif s[k] == "}":
            d -= 1
            if d == 0: return s[i:k+1]
parts = [s[s.index("const esc = s =>"):s.index("\n", s.index("const esc = s =>"))],
         s[s.index("const IMG_EXT"):s.index("\n", s.index("const IMG_EXT"))],
         grab("imgBase"), grab("imgTag"), grab("md")]
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(parts) + "\n")
''')
    rc, out = run([PY, md_py, os.path.join(ROOT, "index.html"), os.path.join(tmp, "md_mod.js")])
    ok("md() 可提取", rc == 0 and os.path.getsize(os.path.join(tmp, "md_mod.js")) > 3000, out.strip()[:120])

    cases = r'''
const src = require("fs").readFileSync(process.argv[2], "utf8");
eval(src.replace(/^const /gm, "var ").replace(/^function /gm, "function "));
const t = [];
const has = (n, inp, want, bad) => { const o = md(inp);
  t.push([n, o.includes(want) && (!bad || !o.includes(bad)), o.replace(/\n/g, "\\n").slice(0, 90)]); };
has("有序列表仍是 <ol>", "1. 一\n2. 二", "<ol>", "<ul><li>一");
has("无序列表是 <ul>", "- a\n- b", "<ul>", "<ol>");
has("嵌套缩进有 class=sub", "- a\n  - b", 'class="sub"');
has("多行引用合成一块", "> 一\n> 二", "<blockquote>一<br>二</blockquote>", "<p><blockquote>");
has("表格单元格里的竖线不拆列", "| a | b |\n|---|---|\n| `x | y` | z |", "<td><code>x | y</code></td>");
has("带括号的 URL 不截断", "见 [w](https://e.org/Foo_(bar)) 余", "Foo_(bar)\"");
has("--- 变 hr", "上\n\n---\n\n下", "<hr>");
has("_斜体_", "这是 _i_ 字", "<i>i</i>");
has("~~删除~~", "这是 ~~s~~ 字", "<s>s</s>");
has("标题尾井号被吃掉", "## T ##", "<h2>T</h2>");
has("普通段落仍是 <p>", "hi", "<p>hi</p>");
has("代码块仍是 pre", "```js\nx\n```", "<pre");
const bad = t.filter(x => !x[1]);
for (const x of t) console.log((x[1] ? "  ok   " : "  BAD  ") + x[0] + (x[1] ? "" : "  → " + x[2]));
process.exit(bad.length ? 1 : 0);
'''
    mdt = os.path.join(tmp, "md_assert.js")
    open(mdt, "w", encoding="utf-8").write(cases)
    rc, out = run(["node", mdt, os.path.join(tmp, "md_mod.js")])
    ok("md() 11 项行为", rc == 0, out.strip().splitlines()[-1] if rc else "")
    print("\n".join("      " + l for l in out.strip().splitlines()))

    # ---- 2. live behaviour harness ---------------------------------------
    for mode in ("main", "login"):
        h = os.path.join(tmp, "hm-verify.js")
        shutil.copyfile(os.path.join(SCRATCH, "hm-verify.js"), h)
        rc, out = run(["node", h, os.path.join(ROOT, "index.html"), mode], timeout=180)
        tail = [l for l in out.strip().splitlines() if l.startswith(("PASS", "FAIL", "=="))]
        ok(f"页面行为 harness[{mode}]", rc == 0, " | ".join(tail[-3:])[:200])
        if rc != 0:
            print("      —— 完整输出 ——")
            print("\n".join("      " + l for l in out.strip().splitlines()[-15:]))
        time.sleep(5)   # 两种模式各会真登录一次，别把 10 次/60 秒的额度挤爆

    # ---- 3. APK build -----------------------------------------------------
    apk = os.path.join(ROOT, "hermes-mobile.apk")
    before = os.path.getmtime(apk) if os.path.exists(apk) else 0
    rc, out = run(["bash", "build.sh"], cwd=os.path.join(ROOT, "apk"), timeout=300)
    ok("apk/build.sh 重打包", rc == 0 and os.path.getmtime(apk) > before, out.strip().splitlines()[-1][:120] if out else "")
    import zipfile
    with zipfile.ZipFile(apk) as z:
        man = z.read("AndroidManifest.xml")
        dex = sum(z.getinfo(n).file_size for n in z.namelist() if n.endswith(".dex"))
    ok("APK 里 allowBackup 已写死", man.count("allowBackup".encode("utf-16-le")) == 1, f"dex={dex}B")

    # ---- 3b. IPv4 bridge --------------------------------------------------
    # Windows binds [::] with IPV6_V6ONLY=1, so without this relay no IPv4 client
    # (a phone on the laptop hotspot) can reach the dashboard at all.
    bridge = os.path.join(ROOT, "ipv4_bridge.py")
    rc, out = run([PY, "-m", "py_compile", bridge])
    ok("ipv4_bridge.py 能编译", rc == 0, out.strip()[:100])

    def http_code(url):
        # Liveness = "did an HTTP response come back at all", so 302 (auth
        # redirect) counts. /api/status is deliberately NOT used: it reaches into
        # the gateway and costs ~0.5 s idle, >6 s under load -- as a probe it
        # turns a busy machine into a fake "address dead".
        # --noproxy '*': these are local/campus addresses; an HTTP_PROXY in the
        # environment (Clash etc.) would swallow the request and report 000 for a
        # perfectly live listener.
        rc, out = run(["curl", "--noproxy", "*", "-s", "-o", os.devnull, "-m", "8", "-w", "%{http_code}", url])
        return out.strip() or "000"

    def ipv4_status():
        return "up" if http_code("http://127.0.0.1:9119/") in ("200", "302") else "down"

    proc = None
    if ipv4_status() != "up":
        proc = subprocess.Popen([PY, bridge, "9119"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            time.sleep(0.4)
            if ipv4_status() == "up":
                break
    ok("IPv4 桥让 127.0.0.1 通（热点路径的前提）", ipv4_status() == "up", "GET / 有响应即算通")

    jar = os.path.join(tmp, "cookies.txt")
    # 口令不在仓库里：环境变量 → keys/dashboard.pass（start.cmd 生成的那份）。
    pwd = os.environ.get("HM_PASS", "")
    if not pwd:
        try:
            pwd = open(os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes", "keys",
                                    "dashboard.pass"), encoding="utf-8").read().strip()
        except OSError:
            pwd = ""
    # 网关的密码登录有节流：10 次 / 60 秒 / 客户端 IP。连着跑两轮验证会撞上 429，
    # 后面所有需要 cookie 的检查都会跟着假红。撞了就等窗口过去，而不是判失败。
    code = ""
    for _ in range(4):
        rc, out = run(["curl", "-s", "-o", os.devnull, "-m", "8", "-w", "%{http_code}", "-c", jar,
                       "-H", "content-type: application/json",
                       "-d", json.dumps({"provider": "basic", "username": "hermes", "password": pwd}),
                       "http://127.0.0.1:9119/auth/password-login"])
        code = out.strip()
        if code == "200":
            break
        time.sleep(20)
    ok("取登录 cookie（429 节流会等窗口）", code == "200", "login=" + (code or "?"))
    rc, out = run(["curl", "-s", "-b", jar, "-m", "6", "-X", "POST",
                   "http://127.0.0.1:9119/api/auth/ws-ticket"])
    ticket = ""
    try:
        ticket = json.loads(out).get("ticket") or ""
    except Exception:
        pass
    ok("走 IPv4 桥取 ws-ticket", bool(ticket), ticket[:12] + "…" if ticket else out.strip()[:100])

    upgrade = "000"
    if ticket:
        rc, out = run(["curl", "-s", "-i", "-N", "-b", jar, "-m", "6",
                       "-H", "Connection: Upgrade", "-H", "Upgrade: websocket",
                       "-H", "Sec-WebSocket-Version: 13",
                       "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                       "http://127.0.0.1:9119/api/ws?ticket=" + ticket])
        upgrade = next((l.split()[1] for l in out.splitlines() if l.startswith("HTTP/")), "???")
    ok("走 IPv4 桥能升级 WebSocket（101）", upgrade == "101", "HTTP " + upgrade)
    if proc is not None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    # MainActivity must not treat a failed subresource as a dead address
    java = open(os.path.join(ROOT, "apk", "src", "com", "hermes", "mobile", "MainActivity.java"), encoding="utf-8").read()
    legacy = java[java.index("public void onReceivedError(WebView v, int code"):]
    legacy = legacy[:legacy.index("}")]
    ok("APK 不再因子资源失败切地址", "getUrl()" in legacy and "equals(failingUrl)" in legacy,
       "legacy onReceivedError 只认主文档")
    ok("APK 已记 pageOk/wantUrl", "private boolean pageOk" in java and "private String wantUrl" in java
       and "errored || pageOk" in java)
    # 手机上真会踩到的四件：外链把壳导航走、渲染进程崩、失败屏没按钮、登录页卡死
    ok("APK 外链交给系统浏览器", "shouldOverrideUrlLoading" in java and "boolean handleNav(Uri u)" in java
       and "isGatewayHost" in java)
    ok("APK 渲染进程崩了会重建", "onRenderProcessGone" in java and "void restartWeb()" in java
       and "new Restart(this)" in java)
    ok("APK 失败屏有『改地址』按钮", "statusBtn" in java and "改地址" in java)
    ok("APK 登录页卡死有看门狗", "LoginWatch" in java and "checkLoginStuck" in java
       and "loginReloads >= 2" in java)
    ok("APK 慢但能连的地址不会被 7 秒误杀", "void onStarted(String url)" in java
       and "deadlineExtended" in java and "resetDeadline(TRY_MS + 5000)" in java)

    # ---- 4. addrs.json ----------------------------------------------------
    rc, out = run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                   os.path.join(ROOT, "refresh_addrs.ps1")])
    ok("refresh_addrs.ps1 跑通", rc == 0 and "Phone:" in out, out.strip().splitlines()[0][:90] if out else "")
    j = json.load(open(os.path.join(ROOT, "addrs.json"), encoding="utf-8"))
    ok("addrs.json 结构正确", j.get("port") == 9119 and isinstance(j.get("urls"), list) and j["urls"], str(len(j.get("urls", []))) + " urls")
    # 热点没开时 192.168.137.1 这块网卡根本不存在，refresh 脚本自然不会写它 ——
    # 所以「有则必须排前 3，没有只要求 IPv4 非空」，别让环境决定这条断言的脸色。
    hot = [i for i, u in enumerate(j.get("urls") or []) if "192.168.137.1" in u]
    ok("addrs.json 里带 IPv4（热点开着时热点地址排前）",
       isinstance(j.get("ipv4"), list) and j["ipv4"] and (not hot or hot[0] <= 2),
       "ipv4=%s 热点@%s" % (j.get("ipv4"), hot))
    live = 0
    probe = []
    total = 0
    for u in j["urls"]:
        if "localhost" in u:
            continue
        total += 1
        code = ""
        for _ in range(3):  # 一次瞬时超时不算死：重试两次
            code = http_code(u)
            if code in ("200", "302"):
                break
            time.sleep(0.5)
        live += 1 if code in ("200", "302") else 0
        probe.append(u.rsplit("/", 2)[-2][-22:] + "=" + (code or "?"))
    ok("addrs.json 里列出的地址真能连", live == total, f"{live}/{total}  " + " ".join(probe))

    # ---- 5. launchers -----------------------------------------------------
    def raw(p):
        return open(os.path.join(ROOT, p), "rb").read()
    for p in ("start.cmd", "show_url.cmd", "refresh_addrs.ps1"):
        d = raw(p)
        crlf = p.endswith(".cmd")
        bad_lf = d.count(b"\n") - d.count(b"\r\n") if crlf else 0
        ascii_only = all(c < 128 for c in d)
        ok(f"{p} 文本卫生", bad_lf == 0 and ascii_only, f"裸LF={bad_lf}, ascii={ascii_only}")
    ok("start.cmd 不再写死 IPv6 地址", b"http://[" not in raw("start.cmd") and b"refresh_addrs.ps1" in raw("start.cmd"))
    ok("show_url.cmd 走 addrs.json", b"addrs.json" in raw("show_url.cmd"))
    ok("start.cmd 会拉起 IPv4 桥", b"bridge_supervisor.py" in raw("start.cmd") and b"start " in raw("start.cmd"))
    ok("supervisor 起来了真桥", b"ipv4_bridge.py" in open(os.path.join(ROOT, "bridge_supervisor.py"), "rb").read())
    sup = open(os.path.join(ROOT, "bridge_supervisor.py"), encoding="utf-8").read()
    ok("supervisor 会定时刷新 addrs.json",
       "refresh_addrs.ps1" in sup and "REFRESH_EVERY" in sup and "daemon=True" in sup)
    ok("地址刷新不弹黑框", "CREATE_NO_WINDOW" in sup or "0x08000000" in sup)

    # ---- 5b. 凭据：一个字节都不许留在仓库里 --------------------------------
    rc, out = run(["git", "ls-files"], cwd=ROOT)
    tracked = [l for l in out.splitlines() if l.strip()]
    leaks = [p for p in tracked if p.endswith((".keystore", ".pass", ".secret"))
             or "keystore" in p.lower()]
    ok("没有密钥库/口令被跟踪", not leaks, ", ".join(leaks) or "clean")

    ign = open(os.path.join(ROOT, ".gitignore"), encoding="utf-8").read()
    ok(".gitignore 挡住签名材料", "*.keystore" in ign and "*.pass" in ign)

    bs = open(os.path.join(ROOT, "apk", "build.sh"), encoding="utf-8").read()
    ok("build.sh 从仓库外读口令", 'KS_PASS="$(cat' in bs and ("hermes" + "123") not in bs)

    sc = raw("start.cmd")
    ok("start.cmd 没有明文密码", b"Hermes" + b"9119" not in sc and b"dashboard.pass" in sc)
    ok("start.cmd 不打密码到屏幕", b"echo   Pass : %HERMES" not in sc)

    java = open(os.path.join(ROOT, "apk", "src", "com", "hermes", "mobile", "MainActivity.java"),
                encoding="utf-8").read()
    ok("APK 里没有默认密码", 'DEF_PASS = ""' in java and ("Hermes" + "9119") not in java)
    ok("网页也不预填密码", "DEF_P = ''" in open(os.path.join(ROOT, "index.html"), encoding="utf-8").read())
    ok("壳会把版本号给页面", "@JavascriptInterface" in java and "HermesApp" in java)

    br = open(os.path.join(ROOT, "ipv4_bridge.py"), encoding="utf-8").read()
    ok("桥失败不再静默退出", "return 2" in br and "_already_serving" in br)

    # ---- 5b2. 公开发布卫生：仓库里不许有本机专属事实 ------------------------
    # 这一组是打包成公开仓库时逐项扫出来的：绝对路径 / 机器名 / 私有地址 /
    # 构建产物。任何一条回退，泄露的就正好是它盯的那个东西。
    rv = raw("runner.vbs")
    ok("runner.vbs 不写死本机路径",
       b"GetParentFolderName(WScript.ScriptFullName)" in rv and b"\\Users\\" not in rv)
    ok("APK 只内置通用候选地址（热点网关）",
       "192.168.137.1:9119" in java and ".local:9119" not in java and "100.64." not in java)
    ok("build.sh 不写死 SDK/JDK 路径",
       "ANDROID_SDK_ROOT" in bs and "D:/tools/jdk-21.0.2" not in bs)
    ok("build.sh 编译失败会停", "javac FAILED" in bs)
    ok("APK 产物不进版本库",
       "hermes-mobile.apk" not in tracked and "hermes-mobile.apk.idsig" not in tracked)
    ok("首页 README + 笔记 docs/NOTES.md 都在",
       os.path.exists(os.path.join(ROOT, "README.md"))
       and os.path.exists(os.path.join(ROOT, "docs", "NOTES.md")))
    ok("仓库有 LICENSE", os.path.exists(os.path.join(ROOT, "LICENSE")))

    # 全仓扫描：老的明文口令 / 密钥库口令不许在任何被跟踪的文件里出现
    stale = []
    for rel in tracked:
        p = os.path.join(ROOT, rel)
        try:
            if os.path.getsize(p) > 4 * 1024 * 1024:      # 跳过大二进制（APK 另算）
                continue
            blob = open(p, "rb").read()
        except OSError:
            continue
        # 拆开拼：不然这个扫描器自己就是「残留」
        for needle in (b"Hermes" + b"9119", b"hermes" + b"123"):
            if needle in blob:
                stale.append(rel + ":" + needle.decode())
    ok("全仓没有旧口令残留", not stale, ", ".join(stale[:4]) or "clean")

    # ---- 5c. 版本号三处一致（manifest / version.json / 页面提示） -----------
    man = open(os.path.join(ROOT, "apk", "AndroidManifest.xml"), encoding="utf-8").read()
    vj = json.load(open(os.path.join(ROOT, "version.json"), encoding="utf-8"))
    code = re.search(r'android:versionCode="(\d+)"', man)
    name = re.search(r'android:versionName="([\d.]+)"', man)
    ok("version.json 和 manifest 版本一致",
       code and name and int(code.group(1)) == vj["code"] and name.group(1) == vj["name"],
       f'manifest={code.group(1) if code else "?"}/{name.group(1) if name else "?"} json={vj["code"]}/{vj["name"]}')
    ok("targetSdk 报 34", 'targetSdkVersion="34"' in man)
    html0 = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    ok("页面会提示更新", "checkUpdate" in html0 and "HermesApp" in html0)
    ok("页面有会话历史本地缓存", "indexedDB" in html0 and "HCACHE" in html0 and "缓存 " in html0)
    ok("切会话有竞态保护", "openSeq" in html0 and "seq !== openSeq" in html0)
    # 手机端体验的六条：都是实测出来的坑，回退一条就在真机上现形
    ok("长按复制有手指容差（10px）",
       "PRESS_SLOP = 10" in html0 and "PRESS_SLOP * PRESS_SLOP" in html0)
    ok("复制内容摘掉按钮和元信息",
       "function bubbleText(" in html0 and "clone.querySelectorAll('.cc, .meta')" in html0)
    ok("代码块按钮不在滚动容器里（prewrap）",
       "wrap.className = 'prewrap'" in html0 and "wrap.appendChild(b)" in html0
       and "pre.appendChild(b)" not in html0 and ".bubble .prewrap{position:relative" in html0)
    ok("翻页补偿作用在真滚动容器上",
       "const h0 = scroll.scrollHeight, t0 = scroll.scrollTop;" in html0
       and "scroll.scrollTop = t0 + (scroll.scrollHeight - h0);" in html0
       and "msgsEl.scrollTop = t0" not in html0)
    ok("表格中文可换行 / 触控热区 44 / 看图可放大",
       "white-space:normal;word-break:break-word;min-width:84px" in html0
       and ".icon::after{content:'';position:absolute;inset:-4px}" in html0
       and "#lightbox.on.zoom{display:block" in html0)
    ok("长按图片交给系统（不复制文字）", "closest('img.hi')) return;" in html0)
    ok("上传期间提示不会消失（每秒刷新）",
       "function uploadTick(" in html0 and "uploadTick('上传 ' + name" in html0
       and "stopTick();" in html0)

    # 走查（真浏览器 390×844）抓到的两条：输入框幽灵滚动条 / 三级列表塌陷。
    # textarea 是 box-sizing:border-box：41px 高、border 2、上下内距 2×p ⇒ 内容区 41-2-2p。
    # p=10 时内容区 19px < line-height 21px，scrollHeight(41) > clientHeight(39)：
    # 空输入框也常驻一条竖向滚动条，末行还被切 2px。p=9 + min-height 41 才正好放满一行。
    ok("输入框单行不溢出（没有幽灵滚动条）",
       "padding:9px 12px" in html0 and "min-height:41px" in html0
       and "max-height:132px" in html0)
    ok("列表第三层有 sub3（48px），不再塌成 sub2",
       ".bubble li.sub3{margin-left:48px}" in html0 and "' sub sub2 sub3'" in html0)

    # 走查第二轮抓到的两条事件处理问题（行为由 harness #32 盯着，这里只防回退）：
    # ① 网关发 error 时只改标志位，S.cur 里的半截气泡留着 → 下一轮回答拼进上一轮；
    # ② 事件过滤带 S.sid，S.sid 未落时别的会话的帧会被画出来。
    ok("出错时收尾半截气泡（调 abortStream，不是只改标志位）",
       "abortStream('出错了')" in html0)
    ok("事件按 session_id 过滤（S.sid 未落时也不画别人的）",
       "t !== 'sessions.changed' && p.session_id !== S.sid" in html0)
    ok("socket handler 会认身份（旧连接迟到的 close 不许清掉新连接）",
       html0.count("if (S.ws !== ws) return;") == 3)
    ok("上传上限提示跟着 FILE_MAX 走", "'，上限 ' + humanSize(FILE_MAX)" in html0)

    # ---- 5d. 图片尺寸预留 + 双指缩放 ---------------------------------------
    # 图片没有 width/height 时，20 张图加载前后页面总高 1718 → 2627（+909px 的 LayoutShift）。
    # 记住 naturalWidth/Height 之后，第二次渲染「刚画完的高度」就等于「全部加载完的高度」。
    ok("图片尺寸记忆（IMGDIM）在", "const IMGDIM = (() => {" in html0
       and "IMGDIM.set(p, im.naturalWidth, im.naturalHeight)" in html0
       and "' width=\"' + d[0] + '\" height=\"' + d[1] + '\"'" in html0)
    # viewport 禁缩放会把代码块永远压在 390 宽；放开之后靠 touch-action 单独挡双击
    # （双击在气泡上是要点开的），双指仍然可用。壳里 setBuiltInZoomControls(false) 会
    # 连 pinch 一起关掉，所以必须 true + setDisplayZoomControls(false) 藏按钮。
    # 只看 viewport 的 content —— CSS 注释里也会出现 "maximum-scale" 这个词，
    # 拿整个 head 做子串匹配会打到自己的说明文字上（这坑已经踩过一次了）。
    vp = re.search(r'<meta\s+name="viewport"\s+content="([^"]*)"', html0)
    ok("双指缩放：页面放开 + 双击仍被挡",
       bool(vp) and "maximum-scale" not in vp.group(1) and "user-scalable" not in vp.group(1)
       and "touch-action:manipulation" in html0,
       vp.group(1) if vp else "no viewport meta")
    ok("双指缩放：壳里没有再把 pinch 关死",
       "s.setSupportZoom(true);" in java and "s.setBuiltInZoomControls(true);" in java
       and "s.setDisplayZoomControls(false);" in java)

    # ---- 5e. markdown 覆盖 + 草稿隔离 -------------------------------------
    # 裸 URL（模型常直接吐地址）、"- [ ]" 计划（以前字面漏出来）、从 5. 起的编号
    # （以前重排成 1.）。三条都是真浏览器里量出来的。
    ok("markdown：裸 URL / 任务列表 / 有序起始号",
       "const links = [];" in html0 and 'li class="task' in html0
       and 'data-n="' in html0 and "const A_TGT" in html0)
    # 草稿必须按会话存：一个全局 key 会让 A 的草稿出现在 B 的输入框里，按发送就发错了人。
    ok("草稿按会话隔离", "'hermes.draft.' + (S.storedId || '_')" in html0)

    # ---- 5f. 断线收尾 / 表格列宽 / 三级嵌套 / 搜索不重置展开数 ----------
    ok("断线时收尾流式气泡（否则 send 永远静默 return）",
       "function abortStream(" in html0 and "abortStream('连接中断')" in html0)
    ok("表格最小列宽 84px（6 列时横滚，而不是挤成 2 字/行）", "min-width:84px" in html0)
    # 缩进分档：2 空 sub / 4 空 sub2 / ≥8 空 sub3。看一眼映射本身 + 两档 CSS 都在。
    # （早先这条盯的是字面量 'class="sub sub2"'，缩进改成 indCls() 之后字面量消失，
    #  行为其实没变 —— 行为归 harness #31 管，这里只验分档表没被改回去。）
    ok("三级嵌套按缩进分档（sub / sub2 / sub3）",
       "ind.length >= 8 ? ' sub sub2 sub3'" in html0
       and "ind.length >= 4 ? ' sub sub2'" in html0
       and ".bubble li.sub2{margin-left:32px}" in html0)
    # 以前搜索框每次输入都把 SHOWN 打回 60：翻了 300 条后输一个字再删，列表跳回顶部
    ok("搜索不再重置展开数",
       "qEl.addEventListener('input', () => { Q = qEl.value; renderList(); })" in html0)

    # ---- 6. 验证的树 == 提交的树（源码不许脏；产物本来就每次重生成） -------
    rc, out = run(["git", "status", "--short", "--",
                   ".", ":(exclude)addrs.json", ":(exclude)hermes-mobile.apk", ":(exclude)hermes-mobile.apk.idsig"],
                  cwd=ROOT)
    ok("源码工作区干净（验的就是 HEAD 那棵树）", rc == 0 and out.strip() == "", out.strip()[:120] or "clean")


if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="hermes-verify-", dir=os.path.join(os.environ["LOCALAPPDATA"], "Temp"))
    print("tmp:", tmp, "\n")
    crashed = None
    try:
        main(tmp)
    except BaseException as e:          # noqa: BLE001 —— 崩了必须报红，不能假装跑完了
        crashed = e
        traceback.print_exc()
    finally:
        bad = [n for n, c in results if not c]
        passed = len(results) - len(bad)          # 只数 PASS，崩溃项不进分母
        if crashed is not None:
            bad.append("main() 抛异常: %r" % (crashed,))
        print(f"\n== {passed}/{len(results)} 通过 ==")
        if not bad:
            shutil.rmtree(tmp, ignore_errors=True)
            print("临时目录已清理")
        else:
            print("失败项:", ", ".join(bad), "\n临时目录保留:", tmp)
        sys.exit(1 if bad else 0)
