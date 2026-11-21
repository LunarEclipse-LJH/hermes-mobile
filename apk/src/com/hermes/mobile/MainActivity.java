package com.hermes.mobile;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;

/**
 * Hermes mobile shell — full-screen WebView on the local Hermes mobile page
 * (hermes-mobile/index.html, served by `hermes dashboard --host 0.0.0.0`).
 *
 * No anonymous inner classes anywhere: the bundled d8 (R8 3.3.20) NPEs on the
 * anonymous-class bytecode JDK 21's javac emits.
 *
 * Connection strategy: every address gets a visible progress line and a hard
 * 7 s deadline; a failure of the DOCUMENT advances to the next address (a failed
 * subresource never does), and the last failure shows what to check plus the
 * manual URL dialog. Never a silent black screen.
 */
public class MainActivity extends Activity
        implements DialogInterface.OnClickListener, DialogInterface.OnDismissListener, View.OnClickListener {

    /**
     * Built-in candidates, tried after the last-good URL and the addresses the
     * user entered. Only addresses that hold for EVERY Windows box belong here:
     * the hotspot gateway is 192.168.137.1 everywhere, while mDNS names and
     * CGNAT / Tailscale addresses are per-machine — those come from the in-app
     * "改地址" dialog (persisted in prefs) instead of being baked into the APK.
     */
    private static final String[] FALLBACKS = {
            // Hotspot gateway: the one address that never rotates, and
            // ipv4_bridge.py makes it answer (Windows keeps IPV6_V6ONLY=1, so
            // the dashboard alone listens on IPv6 and would refuse this).
            "http://192.168.137.1:9119/"
    };
    private static final String DEF_USER = "hermes";
    // 空串 = 不预填：密码只存在手机 prefs 里，装完第一次要自己输一遍。
    // 写死在这里等于把密码编进 APK，而 APK 是要进仓库、要被拷来拷去的。
    private static final String DEF_PASS = "";
    private static final String BG = "#0b0f14";
    private static final String FG = "#8aa0b6";
    private static final int TRY_MS = 7000;
    /** Order to try: last good URL, then remembered ones, then the built-in fallbacks. */
    private final ArrayList<String> cands = new ArrayList<String>();

    private WebView web;
    private TextView status;
    private TextView statusBtn;
    private FrameLayout root;
    private FrameLayout.LayoutParams full;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCb;
    private static final int REQ_FILE = 0x5EA1;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable timeoutTask;
    private EditText urlIn;
    private EditText userIn;
    private EditText passIn;
    private int candIdx;
    private boolean errored;
    /** 地址对话框开着就别再开第二个（fail() 可能被多个回调连着触发）。 */
    private boolean dialogOpen;
    /** 这个 /login 页面已经自动填过一次，别反复提交。 */
    private String loginFilledFor;
    /** /login 页面的提交按钮被它自己的 JS 禁用了，卡住就重载，最多两次。 */
    private Runnable loginWatch;
    private int loginReloads;
    /** 每个候选只有一次「已经开始回字节」的宽限。 */
    private boolean deadlineExtended;
    /**
     * True once the document we asked for has finished loading. After that a
     * subresource failure must never advance to the next address: the page is
     * already usable and a reload only makes the connection look unstable.
     */
    private boolean pageOk;
    /**
     * The URL startCandidate() handed to loadUrl(). Without it, the late
     * onPageFinished of an abandoned candidate could be taken for a success and
     * persisted as "last good URL" — silently turning a dead address into the
     * one the app tries first on every launch.
     */
    private String wantUrl;

    /** Named Runnable — see the class comment about anonymous classes. */
    static final class Deadline implements Runnable {
        private final MainActivity host;

        Deadline(MainActivity host) {
            this.host = host;
        }

        @Override
        public void run() {
            host.onTimeout();
        }
    }

    /** Named client — same reason. */
    static final class Shell extends WebViewClient {
        private final MainActivity host;

        Shell(MainActivity host) {
            this.host = host;
        }

        @Override
        public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
            host.onStarted(url);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            host.onLoaded(url);
        }

        @Override
        public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
            // Legacy callback: fires for SUBRESOURCES too (minSdk 21, and modern
            // WebView still invokes it for them). A single timed-out image on a
            // flaky link used to look like "the address is dead" and rotated away
            // from a page that was already working. Only a failure of the
            // document itself may advance the candidate.
            if (failingUrl == null) return;
            String cur = (v == null) ? null : v.getUrl();
            if (cur != null && !cur.equals(failingUrl)) return;
            host.onLoadError();
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
            if (req != null && req.isForMainFrame()) host.onLoadError();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            return host.handleNav(req == null ? null : req.getUrl());
        }

        /** API 21–23 走的是这个字符串版本；两个都实现，省得老机型上外链在壳里乱跳。 */
        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, String url) {
            return host.handleNav(url == null ? null : Uri.parse(url));
        }

        /** 渲染进程崩了别留死屏：交给 Activity 重建 WebView。 */
        @TargetApi(26)
        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            return host.onRenderGone(v);
        }
    }

    /**
     * 渲染进程被杀之后重建 WebView —— 命名类，理由同 Shell。
     * 默认行为是留一块死屏（或整个 App 崩），只能强杀重开。
     */
    static final class Restart implements Runnable {
        private final MainActivity host;

        Restart(MainActivity host) {
            this.host = host;
        }

        @Override
        public void run() {
            host.restartWeb();
        }
    }

    /**
     * 登录页卡死看门狗。网关自带的 /login 页在提交时会把按钮 disabled，POST 若
     * 因为弱网挂住，那段内联 JS 既不成功也不报错 —— 页面永久停在一个点不动的按钮上。
     * 15 秒还没离开 /login 就重载一次，最多两次。
     */
    static final class LoginWatch implements Runnable {
        private final MainActivity host;

        LoginWatch(MainActivity host) {
            this.host = host;
        }

        @Override
        public void run() {
            host.checkLoginStuck();
        }
    }

    /**
     * 暴露给页面的壳信息 —— 只有版本号。
     * addJavascriptInterface 的每个方法都是页面的攻击面，能少给就少给。
     */
    static final class AppInfo {
        private final MainActivity host;

        AppInfo(MainActivity h) { host = h; }

        @JavascriptInterface
        public String version() {
            try {
                PackageInfo pi = host.getPackageManager().getPackageInfo(host.getPackageName(), 0);
                return "{\"code\":" + pi.versionCode + ",\"name\":\"" + pi.versionName + "\"}";
            } catch (Exception e) {
                return "{\"code\":0,\"name\":\"\"}";
            }
        }
    }

    /**
     * File-chooser bridge: a plain WebView refuses to open <input type="file"> without
     * onShowFileChooser, so image upload would silently do nothing in the shell.
     * Named class for the same d8 reason as Shell.
     */
    static final class Chrome extends WebChromeClient {
        private final MainActivity host;

        Chrome(MainActivity host) {
            this.host = host;
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
            return host.openFileChooser(cb, params);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView makeWeb() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // 双指缩放：页面 viewport 已经放开了 maximum-scale，壳这边也得开着才生效。
        // 内置缩放控件（那对 +/- 按钮）打开再把按钮隐藏 —— setBuiltInZoomControls(false)
        // 连 pinch 一起关掉，不是"只关按钮"。双击缩放由页面的 touch-action 挡着，
        // 免得和气泡点击打架。setSupportZoom 必须先于 setBuiltInZoomControls。
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        w.setBackgroundColor(Color.parseColor(BG));
        w.setWebChromeClient(new Chrome(this));
        w.setWebViewClient(new Shell(this));
        // 页面要知道「我这个壳是哪个版本」才能提示更新；版本号从 PackageManager 读，
        // 不在这里再写一份，省得和 AndroidManifest 对不上。
        w.addJavascriptInterface(new AppInfo(this), "HermesApp");
        // .apk 链接 WebView 渲染不了，不接住就是点了没反应。
        // 关键：系统浏览器没有 dashboard 的登录 cookie，直接丢给它只会下到登录页，
        // 所以用 DownloadManager 并且把 WebView 里的 cookie 一起带上。
        w.setDownloadListener((url, ua, cd, mime, len) -> downloadApk(url));
        return w;
    }

    /** 带 cookie 把 APK 下到系统下载目录，完成后点通知安装。 */
    private void downloadApk(String url) {
        try {
            String cookie = CookieManager.getInstance().getCookie(url);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (cookie != null && cookie.length() > 0) req.addRequestHeader("Cookie", cookie);
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "hermes-mobile.apk");
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("no DownloadManager");
            dm.enqueue(req);
        } catch (Exception e) {
            // 兜底：至少让浏览器试一把（没 cookie 会落到登录页，但好过没反应）
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("hermes", MODE_PRIVATE);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(Color.parseColor(BG));
        getWindow().setNavigationBarColor(Color.parseColor(BG));

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(BG));

        web = makeWeb();

        status = new TextView(this);
        status.setTextColor(Color.parseColor(FG));
        status.setTextSize(13);
        status.setGravity(Gravity.CENTER);
        status.setPadding(56, 56, 56, 56);
        status.setLineSpacing(8, 1f);

        // 失败屏上放个真按钮：不用知道「长按返回」这个暗号，取消掉对话框也不会卡死。
        statusBtn = new TextView(this);
        statusBtn.setText("改地址 / 重试");
        statusBtn.setTextSize(14);
        statusBtn.setTextColor(Color.parseColor("#dbe6f0"));
        statusBtn.setGravity(Gravity.CENTER);
        statusBtn.setPadding(56, 30, 56, 30);
        statusBtn.setBackgroundColor(Color.parseColor("#161f2a"));
        statusBtn.setVisibility(View.GONE);
        statusBtn.setOnClickListener(this);

        full = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(web, full);
        root.addView(status, full);

        FrameLayout.LayoutParams btnLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        btnLp.setMargins(0, 0, 0, 180);
        root.addView(statusBtn, btnLp);

        setContentView(root);

        buildCandidates();
        startCandidate(startIdx());
    }

    /**
     * 上次是不是把所有地址都试挂过：是的话这次从下一个候选开始。
     * 不然每次冷启动都先在一个已经失效的 IPv6 上等满 7 秒。
     */
    private int startIdx() {
        int n = cands.size();
        if (n <= 1) return 0;
        int rot = prefs.getInt("rot", 0) % n;
        return rot < 0 ? 0 : rot;
    }

    /** 渲染进程重建之后回到当前候选列表的第一个。（web 可能为 null） */
    void restartWeb() {
        if (isFinishing() || isDestroyed()) return;
        if (web == null) {
            web = makeWeb();
            root.addView(web, 0, full);
        }
        buildCandidates();
        startCandidate(startIdx());
    }

    /** Rebuild the try-order: last good URL first, then everything remembered, then fallbacks. */
    private void buildCandidates() {
        cands.clear();
        String last = prefs.getString("url", "");
        if (last != null && last.trim().length() > 0) addCand(last.trim());
        String learned = prefs.getString("cands", "");
        if (learned != null) {
            String[] rows = learned.split("\n");
            for (int i = 0; i < rows.length; i++) {
                if (rows[i].trim().length() > 0) addCand(rows[i].trim());
            }
        }
        for (int i = 0; i < FALLBACKS.length; i++) addCand(FALLBACKS[i]);
    }

    private void addCand(String u) {
        if (u != null && u.length() > 0 && !cands.contains(u)) cands.add(u);
    }

    /** A URL that actually loaded: promote it to the front and persist the whole order. */
    private void rememberUrl(String u) {
        cands.remove(u);
        cands.add(0, u);
        while (cands.size() > 6) cands.remove(cands.size() - 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cands.size(); i++) {
            if (i > 0) sb.append('\n');
            sb.append(cands.get(i));
        }
        prefs.edit().putString("url", u).putString("cands", sb.toString()).apply();
    }

    private void startCandidate(int i) {
        if (web == null) return;
        candIdx = i;
        errored = false;
        pageOk = false;
        loginReloads = 0;
        loginFilledFor = null;
        deadlineExtended = false;
        cancelLoginWatch();
        String u = cands.get(i);
        wantUrl = u;
        showStatus("正在连接\n" + u + "\n\n"
                + (i + 1) + " / " + cands.size()
                + " · " + (TRY_MS / 1000) + " 秒后换下一个");
        web.loadUrl(u);
        resetDeadline();
    }

    private void resetDeadline() {
        resetDeadline(TRY_MS);
    }

    private void resetDeadline(int ms) {
        cancelDeadline();
        timeoutTask = new Deadline(this);
        handler.postDelayed(timeoutTask, ms);
    }

    private void cancelDeadline() {
        if (timeoutTask != null) {
            handler.removeCallbacks(timeoutTask);
            timeoutTask = null;
        }
    }

    void onTimeout() {
        timeoutTask = null;
        nextCandidate();
    }

    /**
     * 服务端已经开始回字节了，说明地址是通的，只是这趟慢。
     * 每个候选给一次 +5 秒宽限，否则 7 秒一刀会把「慢但能连」判成死地址，
     * 切走以后再也不回来 —— 这也是一会连得上一会连不上的一个来源。
     */
    void onStarted(String url) {
        if (url == null || wantUrl == null || deadlineExtended) return;
        if (!url.startsWith(wantUrl)) return;
        deadlineExtended = true;
        resetDeadline(TRY_MS + 5000);
    }

    void onLoadError() {
        // A document that already finished loading owns the screen; a failing
        // image or a dropped /assets request is not a dead address.
        if (errored || pageOk) return;
        errored = true;
        cancelDeadline();
        nextCandidate();
    }

    private void nextCandidate() {
        if (candIdx + 1 < cands.size()) {
            startCandidate(candIdx + 1);
        } else {
            fail();
        }
    }

    void onLoaded(String url) {
        if (url == null || errored) return;
        if (url.indexOf(":9119") < 0) return;
        // Only the document we asked for counts. A late onPageFinished from an
        // abandoned candidate would otherwise be persisted as the last good URL.
        if (wantUrl != null && !url.startsWith(wantUrl)) return;
        pageOk = true;
        cancelDeadline();
        rememberUrl(url);
        // 清掉历史：否则后退键会退到上一个已经死掉的候选地址，再触发一轮切换。
        if (web != null) web.clearHistory();
        hideStatus();
        if (url.indexOf("/login") >= 0) {
            fillLogin(url);
            startLoginWatch();
        } else {
            cancelLoginWatch();
        }
    }

    private void startLoginWatch() {
        cancelLoginWatch();
        loginWatch = new LoginWatch(this);
        handler.postDelayed(loginWatch, 15000);
    }

    private void cancelLoginWatch() {
        if (loginWatch != null) {
            handler.removeCallbacks(loginWatch);
            loginWatch = null;
        }
    }

    void checkLoginStuck() {
        loginWatch = null;
        if (web == null) return;
        String u = web.getUrl();
        if (u == null || u.indexOf("/login") < 0) return;    // 已经走开了
        if (loginReloads >= 2) return;                       // 两次还不行，别死循环
        loginReloads++;
        loginFilledFor = null;
        web.reload();
        startLoginWatch();
    }

    private void fail() {
        cancelDeadline();
        errored = false;
        // 下一次冷启动换一个候选打头，别每次都先在同一个死地址上耗 7 秒。
        int n = Math.max(1, cands.size());
        prefs.edit().putInt("rot", (prefs.getInt("rot", 0) + 1) % n).apply();
        showStatus("连不上电脑\n\n"
                + "· 电脑上 start.cmd 窗口要一直开着\n"
                + "· 手机连电脑的「移动热点」最稳：地址固定是\n"
                + "  http://192.168.137.1:9119/  （不会随 IPv6 变）\n"
                + "· 走校园网时 IPv6 会变：电脑上跑 show_url.cmd，\n"
                + "  地址已在剪贴板里，粘贴到下面的输入框\n\n"
                + "点下面的按钮改地址，或长按返回键");
        askUrl();
    }

    private void showStatus(String text) {
        status.setText(text);
        status.setVisibility(View.VISIBLE);
        if (statusBtn != null) statusBtn.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.INVISIBLE);
    }

    private void hideStatus() {
        status.setVisibility(View.GONE);
        if (statusBtn != null) statusBtn.setVisibility(View.GONE);
        if (web != null) web.setVisibility(View.VISIBLE);
    }

    /** On the dashboard's /login page, prefill credentials and submit — once per URL. */
    private void fillLogin(String url) {
        if (url != null && url.equals(loginFilledFor)) return;   // 别在同一页反复提交
        loginFilledFor = url;
        String user = prefs.getString("user", DEF_USER);
        String pass = prefs.getString("pass", DEF_PASS);
        if (user.length() == 0 || pass.length() == 0) return;
        if (web == null) return;
        String js = "(function(){"
                + "var u=document.querySelector('input[name=username]');"
                + "var p=document.querySelector('input[name=password]');"
                + "var b=document.querySelector('button.provider-btn');"
                + "if(u&&p&&b&&!u.value){u.value=" + jsStr(user) + ";p.value=" + jsStr(pass) + ";b.click();}"
                + "})();";
        web.evaluateJavascript(js, null);
    }

    private static String jsStr(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    private void askUrl() {
        if (dialogOpen) return;                      // 两个错误回调同时打过来也别叠对话框
        dialogOpen = true;
        urlIn = new EditText(this);
        urlIn.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlIn.setText(prefs.getString("url", cands.isEmpty() ? FALLBACKS[0] : cands.get(0)));

        userIn = new EditText(this);
        userIn.setInputType(InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        userIn.setHint("username");
        userIn.setText(prefs.getString("user", DEF_USER));

        passIn = new EditText(this);
        passIn.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passIn.setHint("password");
        passIn.setText(prefs.getString("pass", DEF_PASS));

        FrameLayout box = new FrameLayout(this);
        box.setPadding(48, 24, 48, 0);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(urlIn);
        col.addView(userIn);
        col.addView(passIn);
        box.addView(col);

        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("Hermes 地址");
        b.setView(box);
        b.setPositiveButton("连接", this);
        b.setNegativeButton("取消", null);
        b.setOnDismissListener(this);
        b.show();
    }

    /** 对话框关掉就解锁，不然上面那个 dialogOpen 会把它永久锁死。 */
    @Override
    public void onDismiss(DialogInterface dialog) {
        dialogOpen = false;
    }

    /** 失败屏上的「改地址 / 重试」按钮。 */
    @Override
    public void onClick(View v) {
        if (v == statusBtn) askUrl();
    }

    /**
     * 站内 URL 留在壳里，外链交给系统浏览器。
     *
     * 不拦的话，聊天里点一个 http 链接，WebView 会整页导航过去：onLoaded 因为
     * 没有 :9119 不算成功 → 7 秒后超时 → 切下一个候选 → 重新加载 Hermes。
     * 表现就是「点了个链接，App 自己开始重连」。
     */
    boolean handleNav(Uri u) {
        if (u == null) return false;
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https")) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
            return true;
        }
        String host = u.getHost();
        if (isGatewayHost(host)) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
        return true;
    }

    private boolean isGatewayHost(String host) {
        if (host == null || host.length() == 0) return false;
        if (host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("::1")) return true;
        for (int i = 0; i < cands.size(); i++) {
            String h = Uri.parse(cands.get(i)).getHost();
            if (h != null && h.equalsIgnoreCase(host)) return true;
        }
        return false;
    }

    /**
     * 渲染进程被杀（低内存、GPU 崩）时，WebView 的默认结局是一块死屏或直接崩 App，
     * 只能强杀重开。这里自己销毁重建，从候选列表重来。
     * （真正声明它的是 WebViewClient，见 Shell）
     */
    boolean onRenderGone(WebView view) {
        cancelDeadline();
        if (view != null) {
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
        }
        if (web == view) web = null;
        handler.post(new Restart(this));
        return true;   // true = 已处理，别让系统杀掉进程
    }

    @Override
    public void onClick(DialogInterface dialog, int which) {
        String dflt = cands.isEmpty() ? FALLBACKS[0] : cands.get(0);
        String u = urlIn == null ? dflt : urlIn.getText().toString().trim();
        if (u.length() > 0 && !u.startsWith("http")) {
            int colons = 0;
            for (int i = 0; i < u.length(); i++) if (u.charAt(i) == ':') colons++;
            if (u.indexOf('[') < 0 && colons >= 2) {
                u = "http://[" + u + "]:9119";   // bare IPv6 literal, default port
            } else {
                u = "http://" + u;
            }
        }
        if (u.length() == 0) u = dflt;
        prefs.edit()
                .putString("url", u)
                .putString("user", userIn == null ? DEF_USER : userIn.getText().toString().trim())
                .putString("pass", passIn == null ? DEF_PASS : passIn.getText().toString())
                .apply();
        buildCandidates();          // 手输的地址顶到最前，失败还能继续往后试
        startCandidate(0);
    }

    /** Called from Chrome.onShowFileChooser; launches the system picker. */
    boolean openFileChooser(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams params) {
        if (fileCb != null) {
            try { fileCb.onReceiveValue(null); } catch (Exception ignored) {}
        }
        fileCb = cb;
        Intent intent = null;
        if (params != null) {
            try { intent = params.createIntent(); } catch (Exception ignored) {}
        }
        if (intent == null) {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.setType("image/*");
        }
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(intent, REQ_FILE);
            return true;
        } catch (Exception e) {
            fileCb = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) {
            super.onActivityResult(req, res, data);
            return;
        }
        ValueCallback<Uri[]> cb = fileCb;
        fileCb = null;
        if (cb == null) return;
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            ClipData cp = data.getClipData();
            if (cp != null && cp.getItemCount() > 0) {
                int n = cp.getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) out[i] = cp.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        cb.onReceiveValue(out);
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            e.startTracking();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    public boolean onKeyUp(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            if (web != null && web.canGoBack()) {
                web.goBack();
            } else {
                moveTaskToBack(true);
            }
            return true;
        }
        return super.onKeyUp(code, e);
    }

    @Override
    public boolean onKeyLongPress(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            askUrl();
            return true;
        }
        return super.onKeyLongPress(code, e);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        cancelDeadline();
        cancelLoginWatch();
        if (web != null) {
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
