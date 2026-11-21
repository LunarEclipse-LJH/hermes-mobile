# Hermes Mobile · 工程笔记

> 这份是开发过程里量出来的坑与取舍，首页见 [README](../README.md)。
> 所有数字都是真机/真浏览器/真网关上测的，改代码前先读这里对应的那一条。

手机接着电脑端的 Hermes 会话聊天。单页 Web，零依赖。

```
hermes-mobile/
  index.html            手机页面（单文件，深色，移动端布局）
  start.cmd             启动器：起 dashboard + 桥的看护进程 + 读口令文件 + 指向本目录当静态根
  ipv4_bridge.py        0.0.0.0:9119 → [::1]:9119 的 TCP 旁路（见下）
  bridge_supervisor.py  等 dashboard 就绪再起桥、崩了退避重启、全程记日志（见下）
  version.json          页面拿它和壳版本比对，有新包就压一条更新带
  apk/                  安卓壳（WebView）源码；地址和账号都不内置
```

**为什么要 IPv4 桥**：Windows 的 IPv6 socket 默认 `IPV6_V6ONLY=1`，`--host "::"`
起出来的 dashboard **只监听 IPv6**——本机所有 IPv4 地址（含 `127.0.0.1`）一律拒绝。
手机连笔记本的「移动热点」时只有 IPv4，因此原来那条路从设计上就不通。
`ipv4_bridge.py` 绑 `0.0.0.0:9119` 转发到 `[::1]:9119`，是纯 TCP 管道：
WebSocket 升级、取票、大帧全部原样穿过，gateway 看到的对端是 loopback。
它由 `bridge_supervisor.py` 看护：等 `[::1]:9119` 能连上才起桥，桥异常退出按
1s→30s 退避重启，全部写进 `%LOCALAPPDATA%\hermes\logs\hermes-mobile-bridge.log`
（超 1MB 轮转）。端口已被别的桥占着时桥自己退 0，看护进程收工，不会互相抢。
窗口一关整组跟 dashboard 一起没了——这是有意的，别留后台常驻。

**图片怎么显示**：历史里的图片引用是绝对路径（实测 95/95 都是，`@image:C:\...\x.png`），
页面直接把它变成 `/api/fs/download?path=<绝对路径>` —— 要登录 cookie 才给字节。
真 Chrome 实测 `Content-Disposition: attachment` **不影响** `<img>` 子资源（615×90 正常渲染，
26–33 ms）。这里踩过两个坑，别再往回改：

- 以前是启动时把图**硬链接**进 `assets/img/`，页面走 `/assets/img/<名字>`。而
  `dashboard_auth` 的免鉴权前缀里有 `/assets/`，而 9119 在公网 IPv6 上是直连的 ——
  等于所有截图/照片都能被匿名枚举下载（实测未登录 `GET /assets/img/<名>` → 200）。
- 硬链接只在 `start.cmd` 跑一次，所以**新图必须重启**才出现在历史里。

现在 `assets/img/` 和 `link_images.ps1` 整个退役了：图立刻可见，也不再匿名可读。
（顺带记一笔：junction/symlink 走不通，Starlette `StaticFiles(follow_symlink=False)`
会把目录链接 realpath 到 dist 外面拒成 404 —— 这也是当初用硬链接的原因。）

## 启动 / 停止

**开机自己就起来，不用手动开。** 链路三层，任何一层都能单独判断死活：

```
启动文件夹\Hermes_Mobile.vbs   ← 登录时由 Windows 跑，窗口隐藏
  └ runner.vbs                 ← 先 netstat 查 [::]:9119；已在监听就直接退出（幂等）
      └ start.cmd              ← 输出全进 dashboard.log，不开黑框
          ├ hermes dashboard   ← [::]:9119
          └ bridge_supervisor  ← 等 dashboard 就绪后起桥，桥挂了 1s→30s 退避重启
              └ ipv4_bridge.py ← 0.0.0.0:9119 → [::1]:9119
```

`bridge_supervisor` 还兼一件活：**每 5 分钟重跑一次 `refresh_addrs.ps1`**，把 `addrs.json`
按当前网卡状态重写。校园 IPv6 前缀几小时就换一次，只靠启动时刷一次的话，手机下午
看到的「服务端地址」可能已经是上午的地址 —— 表现就是时好时坏。刷新进程用
`CREATE_NO_WINDOW` 起，不会每 5 分钟给你弹一个黑框。

改动过口令 / 页面之后要重启才生效，**别去双击 `start.cmd`**（那会多开一个黑框，
而且关掉黑框等于把服务关了）。走同一层封装：

```bash
wscript C:\path\to\hermes-mobile\runner.vbs
```

它自己判断该不该起，重复跑不会起第二个。停止：`hermes dashboard --stop`。

不想开机自启：删掉（或改名成 `.off`）启动文件夹里的 `Hermes_Mobile.vbs`，
以后双击 `start.cmd` 手动开、窗口留着别关。

服务同时监听 `[::]:9119`（dashboard）与 `0.0.0.0:9119`（IPv4 桥），
`http://localhost:9119/` 和 `http://127.0.0.1:9119/` 都能进。
桥没起来时（比如只跑了 `hermes dashboard` 没跑 `start.cmd`），IPv4 会全部拒连——
`netstat -an | find "9119"` 应该看到两行 LISTENING。

## 验证

三档，从快到全。**跑之前先把 dashboard 起着**（`wscript runner.vbs`），后两档要连真网关。

```bash
npm test        # 页面状态机 40 条（main 38 + login 2），~20s，不需要网关、不碰 APK
npm run verify  # 全量 67 项，~90s：真打包 APK + 真网关 + 上面 40 条 + 静态事实
```

`npm run verify` 就是 `python3 tools/verify_all.py`，也是唯一能说「改完了」的那档。它会：

1. 用 `aapt2` + `javac` + `d8` + `apksigner` 真的把 `apk/` 编成 APK（所以 `MainActivity.java` 的改动是真编进去了，不是看一眼字符串）；
2. 起真网关、真登录、跑 `tools/hm-verify.js` 的 `main` / `login`；
3. 对 20 多条静态事实做子串断言（viewport、触控热区、缓存信号、上传上限……）；
4. 最后一条是 **「验证的树 == 提交的树」**：源码必须已提交。所以顺序永远是 `git commit` → `verify`。

APK 每次重签名字节都不同（PKCS#7 的签名时间），脚本跑完会自己
`git checkout -- hermes-mobile.apk*` 还原，不必手动收拾。失败时它**保留**临时目录
（`%TEMP%\hermes-verify-*`）供翻日志，成功才删。

挑单条断言来跑：

```bash
node tools/hm-verify.js index.html main    # 只跑主状态机
node tools/hm-verify.js index.html login   # 只跑登录/重连退避
```

依赖：Node ≥ 18、Python 3、JDK 17+、Android SDK（`ANDROID_SDK_ROOT` /
`ANDROID_HOME`，脚本会自己挑最新的 build-tools 与 platform），keystore 在
`%LOCALAPPDATA%\hermes\keys\`（见「安全边界」）。

## 手机怎么连

**地址是会变的，别背 IP。** 运营商/校园网 RA 下发的 IPv6 前缀在每次重启/重连后可能变，
而且有效期只有几小时（实测 `PreferredLifetime` ≈ 4h）。写死一个地址，就会出现
「一会连得上一会连不上」——那正是地址换了而手机还在敲旧 IP。

当前地址永远是这两个地方：

- 电脑上双击 `show_url.cmd` → 打印当前地址并**复制到剪贴板**
- 聊天页左侧抽屉底部「服务端地址」→ 点一下复制（数据来自服务端的 `addrs.json`）

手机端：长按返回键 → 粘贴 → 连接。APK 会把连通过的地址记下来，下次先试它，
失败再依次试别的（含热点网关）。

装 APK：自己 `bash apk/build.sh` 出的 `hermes-mobile.apk`（仓库不带产物）。

1. 手机浏览器打开 APK 文件 → 允许"安装未知来源应用"
2. 打开「Hermes」→ 自动按顺序试地址
3. 第一次要输一次密码（APK 里没有默认密码），之后自动登录
4. 想换地址：**长按返回键**，或失败屏上点「改地址 / 重试」

签名用的是仓库外那个 keystore（第一次 `bash apk/build.sh` 自动生成）。
**同一个 keystore 出的包才能覆盖安装**，换机器/换 keys 目录就得先卸载。

壳里几件不显眼但会咬人的事，都已经处理：

- **外链交给系统浏览器**：聊天里点 http 链接，WebView 不再整个导航过去
  （那样会被当成"地址失效"，7 秒后自己开始重连）；站内地址仍然留在壳里。
- **渲染进程崩了会自愈**：低内存/GPU 崩导致 WebView 死掉时，销毁重建而不是留一块死屏。
- **登录页卡死看门狗**：网关自带 `/login` 提交时会把按钮 disabled，POST 在弱网下挂住
  就永久点不动；15 秒还没离开就重载，最多两次。
- **成功加载后清历史**：后退键不会退到上一个已经死掉的候选地址。
- **冷启动轮换起点**：上次全挂过，这次从下一个候选打头，不再每次先等同一个死地址 7 秒。

APK 源码在 `apk/`，改完 `bash apk/build.sh` 重出包（设好 `ANDROID_SDK_ROOT`
与 `JAVA_HOME` 即可；javac 的原始报错现在会整段落盘到 `build/javac.log`）。

## 连接顺序

APK 每次启动按这个顺序试，每个 7 秒：

| 顺序 | 地址 | 什么时候有用 |
|---|---|---|
| 1 | 上次连通的地址（存在 SharedPreferences） | 常态 |
| 2 | `addrs.json` 里学到过的历史地址 | 前缀没变回来时 |
| 3 | `http://192.168.137.1:9119/` | 电脑开热点 · **地址固定，永不变** |
| 4 | 你自己填的固定地址（长按返回键 → 地址框，存进 prefs） | 稳定名字 / 隧道域名 / 任何不漂移的地址 |

全失败才弹地址框。**关键区别**：以前连通过一次就被钉死在那一个 URL 上，地址一变就
永远连不上；现在失败会继续往下试，并且每次成功都重排优先级。

另外两条也修了：子资源（一张图、一次 `/assets/` 请求）失败**不再**当成"地址死了"
去换下一个——那会让已经连上的页面自己重载，看着就像"连上又掉"；被放弃的地址迟到的
加载回调也不会再被记成"上次成功"。

> 想要零配置且永不漂移：手机连笔记本热点，用 `http://192.168.137.1:9119/`。
> 用公网 IPv6 时仍受 RA 前缀漂移影响，`show_url.cmd` 是唯一的真相来源。

> 想彻底摆脱地址漂移，唯一干净的办法是给机器一个稳定名字（Tailscale / 自带域名的
> 隧道）。IPv6 字面量 + 校园 RA 这个组合，改多少次代码都躲不开。

## 登录

```
用户名  hermes
密码    见 %LOCALAPPDATA%\hermes\keys\dashboard.pass
```

密码不在仓库里，也不在 APK 里。第一次启动 `start.cmd` 时生成一个随机口令落在
`%LOCALAPPDATA%\hermes\keys\dashboard.pass`，读一遍抄到手机上，之后 prefs 记着。

要换密码就删掉那个文件重启 `start.cmd`（或直接改文件内容）；换完手机上重新输一次。
APK 里**没有**默认密码，装完第一次必须手输。

## 能干什么

**对话**
- 列出电脑上**所有**会话（终端 / 桌面端 / 飞书 / QQ / 定时任务，同一个 state.db）
- 点开任意一个 → 完整历史 → 接着聊。**是同一个会话，不复制、不分叉**
- 流式回复（按帧节流渲染，长回复不卡）、工具调用提示、思考中状态
- **停止按钮**：回复中发送键变红色「停止」，点了立刻打断（`session.interrupt`）
- 长按任意气泡复制整条；代码块右上角有「复制」按钮
- 消息间隔超过 30 分钟自动插入日期分隔线
- 输入框草稿自动保存，切走再回来还在
- 上滑阅读时新消息不抢滚动，「↓」按钮上显示未读数

**聊天气泡**
- Markdown：标题 / 粗体 / 斜体 / 行内码 / 链接 / 引用 / 有序无序列表 / 代码块 / **表格**（含对齐）
- 代码块左上角显示语言标签，右上角「复制」
- **工具调用卡片**：头行是 `工具名 · 参数摘要 · 运行中/完成`，点一下展开完整参数和结果
- 流式输出（rAF 节流）、停止按钮、每轮 `耗时 · token · tok/s`

**会话列表**
- 搜索过滤（标题 / 预览 / 来源）
- 按时间分组：今天 / 昨天 / 最近 7 天 / 月份
- **定时任务（cron）产生的会话默认隐藏**，列表顶部显示「已隐藏 N 个定时任务 · 点这里显示全部」，点一下切换
- 每项右侧 ✕ 归档（从列表移除，消息保留，不是删除）
- 当前会话高亮边框
- 默认显示 60 条，可「显示更多」

**工具审批**
- agent 要跑危险命令（`rm -rf`、`git push --force`、`systemctl` 之类）时，电脑端会弹框等你点。手机端现在也会：底部弹出橙色卡片，显示命令原文和说明，四个按钮 —— **批准 / 本会话都批准 / 总是批准 / 拒绝**
- 靠 `client.capabilities {server_requests:true}` 声明能力，网关才会把 `approval` 请求推过来（不声明就静默丢弃，agent 干等到超时）
- 断线重连时从 `session.resume` 的 `open_requests` / `pending_approval` 把没答的卡重放出来
- 不支持的请求（`clarify` / `sudo` / 密钥等）立刻回 `-32601`，后端会快速撤回而不是干等

**图片**
- 输入框左侧 🖼 按钮 → 调系统相册/文件选择器（可多选）
- 自动压到最长边 1600px、JPEG 0.85，8 MB 原图也能发
- 附上后输入框上方出缩略图，点 × 可撤；只发图不打字也行
- 后端走 `image.attach_bytes`（单张上限 25 MB），attach 后下一轮 prompt 自动带上
- 实测 deepseek-flash 能读图（识别出了测试图里的文字）
- **历史图片能看了**：老消息里的 `@image:<路径>` / `[Image attached at: <路径>]` 自动渲染成真图，点一下全屏放大
- 图片走鉴权的 `/api/fs/download?path=<绝对路径>`（要 cookie），不用重启服务，也不再匿名可读
- 图真不在了（文件被删）时显示「🖼 xxx.png 未同步到手机端」，不留裸路径

**任意文件（PDF / docx / xlsx / pptx / zip / 代码 / 音频…）**
- 输入框左侧 📎 按钮 → 系统文件选择器（可多选），和相册是两个入口
- 单文件上限 **10 MB**：字节以 base64 走 `file.attach`，不经过 HTTP 上传路由
  （dashboard 这条 surface 上 `/api/chat/file-upload` 是 404，`browser_files=False`，
  所以只能走 WS 里的 `data_url`；网关自己的上限是 256 MB，是手机内存先到）
- **为什么是 10 而不是 25**：`FileReader` 先读成 dataURL（+33%），再塞进一帧 JSON 字符串
  （又一份），峰值内存 ≈ 2.7 倍 —— 25 MB 的文件要吃 67 MB 堆，手机上很容易直接把 WebView
  撑崩。10 MB 峰值约 27 MB，标签页还活着。真要发更大的走分片
  （网关有 `/api/files/upload-stream`），别在这条路上加内存
- 网关把文件落到 `%LOCALAPPDATA%\hermes\attachments\`，回一个 `@file:<绝对路径>`
- 发送时把引用**前置**进正文（`@file:...\n你的话`），模型就能用文件工具读它；
  附件条上有文件名和大小，× 可撤；切换会话/新对话时自动清空
- 重名不覆盖：同名的第二个文件会存成 `xxx-2.ext`
- 实测：上传含随机暗号的 txt → 引用提交 → 模型原样回出暗号（15.6s）
- 历史消息里的 `@file:<路径>` 渲染成「📎 文件名」条，不显示裸路径、也不给下载链接
  （文件在电脑上，手机端没有它的字节）

**模型与用量**
- 顶栏副标题实时显示：`当前模型 · 累计 token · 平均 tok/s`
- 每条回复下方：`时间 · 耗时 · 本轮 token · 生成速度`
- **点顶栏标题 → 模型选择器**：9 个 provider、115 个模型，带搜索，当前模型高亮
- 切换是**会话级**的，不动电脑端配置；同会话下次还用它
- 列表里能看到 `moa`（Mixture of Agents）预设，选它这一轮就走多模型聚合

**其他**
- 断线自动重连（指数退避），心跳 15s
- **报错说人话**：`The gateway is running a turn…` → 「电脑端正在跑这一轮，等它跑完再发」；超时 / 断线 / 401 / 429 / 5xx 各有对应中文
- 发送失败的那条消息下方直接出「↻ 重发」按钮，点了把原文填回输入框重发
- 打开就回到上次用的那个会话
- 深色主题、刘海屏/手势条安全区适配
- 关键操作有触觉反馈（支持震动的机型）

## 为什么不用官方 dashboard 的 Chat 页

Windows 原生 Python 没有 POSIX PTY，官方 dashboard 的 Chat 标签页（xterm.js 里跑 `hermes --tui`）在这台机器上直接显示"请用 WSL2"。所以这个页面绕开 PTY，直接连 `/api/ws` 的 JSON-RPC：

```
session.list      → 会话列表
session.resume    → attach 到一个已有会话（就是"接续电脑端"）
session.history   → 拉完整历史
prompt.submit     → 发消息，事件流推回来
session.create    → 新对话
```

## 改密码

口令在文件里，不在代码里：

```
%LOCALAPPDATA%\hermes\keys\dashboard.pass       登录密码（basic auth）
%LOCALAPPDATA%\hermes\keys\basic_auth.secret    会话签名密钥，换个值旧 cookie 全失效
%LOCALAPPDATA%\hermes\keys\hermes.keystore      APK 签名私钥
%LOCALAPPDATA%\hermes\keys\keystore.pass        上面那个私钥的口令
```

改法：直接编辑 `dashboard.pass` 或删了让它重启时重生成，然后重启 `start.cmd`；
手机上重新输一次密码（APK 里没有默认密码，本来就靠手输）。

`start.cmd` 只在文件缺失时生成，不会覆盖你改过的内容，也**不再把密码打到屏幕上**。

## 会话历史缓存

网关的 `session.history` **不支持分页**（传 `limit` 会被忽略，直接返回 0 条），所以打开
一个会话就是把全部消息拉下来：实测 839 条的会话一次 **1.02 MB**（其中 49% 的条数、
40% 的字节是页面根本不画的 tool 行），`session.resume` + `session.history` 暖机 1.4 s，
网关冷重建时能到 17 s。

页面因此把开过的会话尾巴（最近 600 条文本）存在 **IndexedDB** 里，最多留 8 个会话、
按最后访问时间淘汰。第二次点进同一个会话时先用缓存渲染（Chromium 实测 400 条 / 367 KB
**读 1 ms**、写 3.7 ms），副行会短暂显示「缓存 N 分钟前 · 同步中…」。

**命中判定**：写缓存时把 `session.history` 回的 `count`（服务端权威条数）一起存成 `n`；
再打开时点数没变，就认为没有新消息，**连 `session.history` 都不发**（省掉整包 1 MB），
只顺手拉一次列表（26 KB / ~100 ms）核对点数——真多了消息再补拉。
实测（真浏览器 + 真网关，Chromium 390×844）：命中时 `session.history` 调用 **0 次**、
打开 1.3 s；把点数改大 1 后立刻退回 **1 次** / 1.9 s。老缓存没有 `n` 字段，命不中，走老路。

**三条别踩回来的坑**（都会把命中率打成 0）：

1. `n` 必须用 `session.history` 回的 `count`，**不能用 `session.list` 行里那份**。
   列表可能是几分钟前拉的，电脑端刚聊过就是过期值，记下一个偏小的 `n` 会让这份缓存
   **永远**命中不了。（实测两者在同一时刻相等：94/94、181/181，但新鲜度不同。）
2. 手机上**聊完一轮要把本轮并进缓存**（`rememberTurn`）：发一条消息服务端条数就变了，
   只靠「拉历史时写缓存」的话，你聊过的会话每次都得重拉。收尾后等 `sessions.changed`
   那次 1.5 s 防抖列表刷新落地，再按刷新后的 `message_count` 重写（页面内等 2.6 s）。
   列表还没刷新到就**不写**——宁可下次多拉一次，也不记错点数。带图片附件的一轮直接
   放弃写缓存：`@image:<path>` 引用是网关在服务端补的，本地拼不出来，写进去就是缺图的假命中。
3. 冷启动（`connect()`）也要走缓存：以前是无条件 `pullHistory`，等于每次锁屏回来都白扔
   一次全量。

实测六个会话 `resume`+`history`：94 条 168 KB/496 ms、181 条 496 KB/1008 ms、
58 条 360 KB/889 ms……合计 **1.10 MB / 4.3 s**——这就是每次「没命中」的真实代价。

> `session.list` 的 `message_count` 在 `resume` / `history` 前后是同一个值（实测 50 → 50），
> 不会因为会话变 live 而跳；而 `session.resume` 自己返回的 `message_count` 会跳（840 vs 1899），
> 所以判定只能用列表里的那份（写缓存则用 `history.count`）。

限制：缓存按 **origin** 存，换个地址连（IPv6 变了、从热点换校园网）就是新 origin，
缓存不通用——和草稿 `localStorage` 的行为一致。

## 历史翻页与流式渲染

- **翻页**：默认画最近 160 条，更早的不再是一句「已折叠」——顶部有「加载更早的 N 条」，
  点一次往前 160 条，按 `scrollHeight` 差把视口钉在原处（`HIST_PAGE`，index.html 里改）。
  条数只算真会画出来的：assistant 里那些只带 tool 调用、`text` 是空串的壳会被跳过，
  否则「还有 N 条」的数字会虚高。
- **增量插节点**：翻页只把新增那 160 条插到按钮后面（`DocumentFragment` + `insertBefore`），
  已经画好的气泡一个不动。以前是清空整表重画——翻到 480 条就是 480 个气泡 + 480 次
  `md()` 重新解析，手机上真会卡半秒。
- **补拉不缩回**：同一个会话补拉（重连 / 点数变了）保留已翻开的深度（`renderHistory(list, true)`）；
  **换会话**才回到 160。以前每次重连都缩回 160，视口还跳到底。
- **流式**：回答超过 8 KB 后改成 120 ms 一帧（原来是每个 `requestAnimationFrame` 都全文
  重跑 `md()` 再重设 `innerHTML`，长回答是 O(n²)）；尾随定时器保证最后一帧一定落地。

## 手机端交互：十四个实测过的坑

这些都在真 Chrome（390×844 / DPR 3）里量过，改回去会立刻现形。`verify_all.py` 里各有一条断言盯着。

1. **翻页的视口补偿必须作用在 `main#scroll`**，不是 `#msgs`。`#msgs` 不是滚动容器，
   它的 `scrollTop` 恒为 0 —— 以前 `msgsEl.scrollTop = t0 + Δh` 是死代码，全靠 Chrome 的
   scroll anchoring 兜着。实测**关掉 anchoring 立刻漂 −15607 px**；iOS 的 WKWebView 不做
   anchoring，会直接跳走。补偿前还要临时 `overflow-anchor:none`，否则浏览器和代码各补一次 = 滚双倍。
2. **长按复制要留手指容差**。以前 `touchmove` 一触发就 `clearTimeout`，真机 550 ms 内不可能
   零位移 —— 实测抖 3×2 px 就复制不出东西。现在 `PRESS_SLOP = 10`，超出 10 px 才取消。
3. **复制的文本要摘掉 `.cc` / `.meta`**。按钮和时间戳也在 `.bubble` 里，`innerText` 会把
   「复制」两个字一起带出去（实测复制代码块末尾多一行「复制」）。`bubbleText()` 先 clone、
   删掉这两类节点；clone **必须挂进文档**，离屏节点的 `innerText` 会退化成 `textContent`，换行全丢。
4. **代码块的「复制」按钮不能放在 `pre` 里**。`pre` 是横向滚动容器，按钮 `absolute` 在里面
   会跟着内容跑（实测横滚 256 px 后按钮 x 从 322 → 66，直接压在代码上）。现在包一层
   `.prewrap`，按钮挂外层；顺带让 `pre` 的 `innerText` 不再包含按钮文字。
5. **表格单元格要 `white-space:normal`**。以前 `nowrap`，中文长句也顶着不换行 —— 实测三列表格
   撑到 **893 px**（视口 338），要横拖 555 px 才看完一行。现在中文换行，表格 338/338 正好。
6. **看图不能只能缩小**。`max-width:100%` + 页面 `maximum-scale=1` 会让 615 宽的图在 390 视口里
   被压到 390，长截图按高度限死后只剩一百多像素宽。现在点一下图切成原始尺寸（`#lightbox.zoom`，
   容器可滚、可拖动），再点回适应；只有点黑底才关（以前点图任意处就关，想看清楚都做不到）。
   关闭按钮改 `position:fixed`，zoom 滚动时才不会被带走。

7. **长按图片不要抢**。`touchstart` 挂在 `#msgs` 上、用 `closest('.bubble')` 找目标，
   图片也在气泡里 —— 实测长按一张图，剪贴板拿到的是「图 0」这种正文，而用户想要的是
   WebView 的「保存图片」。现在 `closest('img.hi')` 命中就直接 return，交给系统。
8. **上传要有持续指示**。`toast` 1.8 秒自己消失，而 10 MB 的 base64 走 WebSocket 要十几秒 ——
   中间一根毛的反馈都没有，看起来就是卡死。`uploadTick(label)` 每 0.5 秒刷一次 toast
   （顺带显示已用秒数），`attachFile` / `attachImage` 全程挂着，结束才收。
9. **图片要预留尺寸**。`<img>` 不带 `width`/`height` 时高度是 0，图片一到位就把下面全推下去 ——
   实测 20 张图 **1718 → 2627 px（+909）**。`IMGDIM` 在 `load` 时记下 `naturalWidth/Height`
   （存 `localStorage['hermes.imgdim']`，上限 400 条，300 ms debounce 落盘，`pagehide` 兜底），
   下次 `imgTag` 直接写进 `width`/`height`，浏览器按真实比例留位。
   实测：第一轮 jump **5159 px**，第二轮 **0 px**（`h0 == h1 == 6881`）。
   第一次看新图仍会跳一次，这是没尺寸信息时的下限 —— 但只跳一次。
10. **别用 viewport 禁缩放**。原来是 `maximum-scale=1` + 壳里 `setSupportZoom(false)`，
   代码块永远压在 390 宽、看不清。现在 viewport 放开，壳里 `setSupportZoom(true)` +
   `setBuiltInZoomControls(true)` + `setDisplayZoomControls(false)`（第三行是藏掉那对 +/-
   按钮，**不能**用 `setBuiltInZoomControls(false)` 代替，那会把 pinch 一起关死）。
   双击缩放由 `body{touch-action:manipulation}` 单独挡掉 —— 双击在气泡上是要触发的。
   实测 `Input.synthesizePinchGesture` 之后 `visualViewport.scale` **1 → 2.0**。
11. **草稿必须按会话存**。原来是一个全局 `localStorage['hermes.draft']`：在 A 打一半字切到 B，
    B 的输入框里摆着 A 的话，按发送就**发到 B 去了**；`clearDraft()` 删的也是同一个 key，
    A 的草稿跟着一起没。现在 key 是 `hermes.draft.<storedId>`，`openSession` 第一行就 `loadDraft()`。
    实测：A 存 `AAA-…` → 切 B 输入框空 → 切回 A 还是 `AAA-…`。
12. **`target="_blank"` 在 APK 里会把链接吞掉**。WebView 的 `setSupportMultipleWindows` 默认
    **true**，`_blank` 走 `onCreateWindow`，而壳里没实现它 —— 链接被直接丢弃，连
    `shouldOverrideUrlLoading`（那套「站内留壳 / 外链给系统浏览器」）都到不了。
    现在 `A_TGT` 按 `window.HermesApp` 分支：APK 里不带 target（走已验证的导航拦截），
    浏览器里保留 `_blank`（否则整页被导航走，当前会话就没了）。两个分支都在真浏览器里验过。
13. **断线必须把流式气泡收尾**。`ws.onclose` 以前什么都不做：`S.cur` 和光标一直挂着，
    `S.streaming` 永远是 true —— 而 `send()` 第一行是 `if (… || S.streaming) return;`，
    **静默返回，一点提示都没有**。电梯里断一次网，回到桌面就发不出消息了。
    现在 `onclose` 第一行调 `abortStream('连接中断')`：保留已经流出来的文字、去掉光标、
    补一条 `… · 连接中断` 的时间戳，`S.cur`/`S.streaming` 归零。
14. **搜索框别重置展开数**。`input` 事件里原来有 `SHOWN = 60`：翻了 300 条列表、想搜一下、
    输错一个字删掉 —— 列表直接跳回顶部 60 条。删掉那一行即可（搜索本身不截断，走 `rows.length`）。

顺带：`.icon` / `.item .del` / `.cc` 的触控热区都用 `::after{inset:-Npx}` 撑到 44–46 px，
视觉尺寸不变（iOS HIG 44 / Material 48 的底线）。

还有两条**没做**，写在这儿免得反复讨论：

- **图片响应没有 `Cache-Control`**（`/api/fs/download` 是 Hermes 核心的 `FileResponse`）。
  现在只有 ETag / Last-Modified，浏览器每次重新渲染会发一次条件请求换 304 —— 很便宜，
  但比 `max-age` 多一个往返。要改只能动 `hermes_cli/web_routers/files.py`，而 `hermes update`
  会覆盖掉，收益不值这个维护成本。
- **`/favicon.ico` 404**：页面已经有 `<link rel="icon" href="/favicon-32.png">`，这个 404 是
  浏览器对根 favicon 的兜底探测，页面上要消掉只能靠服务端路由，同样属于核心。

## markdown 渲染：支持到什么程度

`md()` 是手写的一百多行正则管道，不是完整的 CommonMark。**已支持**：围栏代码块（带语言标签、
复制按钮）、表格（中文可换行 + 列多时横滚，切单元格时不把反引号里的 `|` 当分隔符）、
标题（`#`–`####`，四级统一降成 `h3`）、引用、`---`、有序/无序列表（三级缩进，`sub` / `sub2`）、
行内 code / 粗 / 斜 / 删除线、
`[文字](url)`、**裸 URL**、**任务列表** `- [ ]` / `- [x]`、图片与 `@file:` 引用。

**不支持**（按需再加，别以为是 bug）：表格的 `:---:` 对齐、代码高亮、脚注、定义列表、
HTML 内嵌、`####` 以下的标题层级。

三条是实测补的：

| 现象 | 原因 | 现在的做法 |
|---|---|---|
| 裸 `https://…` 点不了 | 只认 `[文字](url)` | 加一条裸 URL 规则，尾部粘的中文标点/右括号留在标签外 |
| `- [ ] 做事` 原样吐出 `[ ]` | 没有任务列表分支 | `li.task` / `li.task.done`，`::before` 出 ☐ / ☑，包在 `ul.tasks` 里 |
| `5.` 开头的列表渲染成 `1.` | `<ol>` 没写 `start` | li 带 `data-n`，包 `ol` 时读第一项写 `start="5"` |
| 6 列表格每格挤成 2 字/行 | `td` 的 `min-width` 只有 48px | 提到 **84px**：列少自适应，列多自动横滚（实测单元格高 69 → 50px） |
| 三级缩进的列表塌成两级 | 只有 `sub` 一档 | 缩进 ≥4 空格再加 `sub2`（`margin-left:32px`） |

markdown 链接现在**先抽成占位符**再跑裸 URL 规则，否则 `href="https://…"` 里的地址会被
再包一层 `<a>`，变成嵌套标签。

## 会话列表排序

`session.list` 由网关的 `list_sessions_rich(order_by_last_active=True)` 排好，就是**最近活动序**。
页面前端**不再二次排序**——那行 `sort(updated_at || started_at)` 是个 bug：返回的行里根本没有
`updated_at`（字段只有 `id/message_count/preview/source/started_at/title`），退化成了按创建时间，
把刚聊过的会话压到下面去。冷启动自动打开的那个会话也因此是「最后动过的」。

同源的第二个 bug 一并删了：抽屉里的**日期分组标题**（今天/昨天/最近 7 天/11 月…）也是拿
`started_at` 算的。实测列表前几行是 11-19 / 11-20 / 09-22 / 11-15 / 09-21（活动序），
按创建时间分组的结果就是组标题 `11月→今天→9月→11月` 来回跳。每条 item 自己带相对时间，
分组纯噪音，直接去掉。要恢复分组，先让 `session.list` 带上「最后一次活动时间」——那是网关
契约的改动，别在页面上编。

## 安全边界

- 服务监听 `[::]:9119`，**IPv6 公网可达**——任何能连到这个地址的人都会看到登录页，密码是唯一门槛
- `/assets/` 这个前缀在 `dashboard_auth` 里是**免鉴权**的：仓库里因此不放任何非公开素材，
  历史图片走 `/api/fs/download`（要 cookie）—— 曾经那 14 MB 可匿名枚举的截图目录已经整个删掉
- `/api/status` 免鉴权（在 Hermes 核心，不是本目录能改的）；登录有 10 次/60 秒的限流
- 初始口令由 `start.cmd` 用 `secrets.token_urlsafe(16)` 生成（22 字符），只落进
  `%LOCALAPPDATA%\hermes\keys\dashboard.pass`，不打印；手改过就以文件内容为准（可短可长，
  页面上不校验格式）
- 签名私钥、口令、会话密钥都在仓库外（`%LOCALAPPDATA%\hermes\keys\`，可用 `HERMES_KEYS` 改），
  `.gitignore` 也挡了一层；首次提交前全树扫过，仓库里一个字节都没有
- 不想被公网访问：把 `start.cmd` 的 `--host "::"` 改成 `--host "::1"`，只本机可连
- 用完后 `hermes dashboard --stop` 关掉就是最彻底的关门

## 排错

| 现象 | 查什么 |
|---|---|
| 手机打不开页面 | 电脑上 `curl "http://[::1]:9119/api/status"`，本地通就是手机侧网络/IPv6 问题 |
| 电脑上 `127.0.0.1` 打不开 | 正常。绑 `::` 后 IPv4 不监听，用 `localhost` 或 `[::1]` |
| 一直"断线，重连中" | dashboard 没在跑，或端口被别的进程占了 |
| 会话列表空 | state.db 里当前 profile 没会话 |
| 提示 409 `client_upgrade_required` | 别把官方构建的 dist 覆盖到这个目录，本目录只放这个 index.html |
| 历史图片显示「未同步」 | 控制台看 `GET /api/fs/download?path=…` 的状态：403/404 说明那条路径已经不在磁盘上（图被删了）；401 是会话过期，重连即可。**不用再重启服务**：路径是即取即用的 |
| 审批卡片不弹 | 看浏览器控制台有没有 `client.capabilities` 报错；没有它网关不推审批 |
| 想同时开官方 dashboard | 会抢 9119。换个 `--port`，两边都改 |

## 卸载

```bash
hermes dashboard --stop
```

然后删掉本目录即可。
