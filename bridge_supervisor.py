"""Supervise the IPv4 -> IPv6 bridge.

Why
---
The bridge is the only path a phone on the laptop hotspot (IPv4-only) has to the
dashboard, and `start /b` gives it nowhere to report failure: if it cannot bind,
or something else already holds the port, it dies invisibly and the phone just
says "cannot connect".  This supervisor does three things the bare script cannot:

* waits for the dashboard to accept on [::1]:PORT before spawning the bridge,
  so the first connection a phone makes is not a 5-second timeout;
* restarts the bridge if it exits non-zero, with capped backoff;
* writes every line to a log file, so a failed connection has a paper trail.

Exit codes from the child are respected: 0 means "the port is already served"
(benign -- another bridge is up), and the supervisor stops instead of fighting
over the port forever.

Usage: python bridge_supervisor.py [port]
"""

import asyncio
import os
import subprocess
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9119
HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "ipv4_bridge.py")
ADDRS_PS1 = os.path.join(HERE, "refresh_addrs.ps1")
LOGDIR = os.path.join(os.environ.get("LOCALAPPDATA", HERE), "hermes", "logs")
LOG = os.path.join(LOGDIR, "hermes-mobile-bridge.log")
MAX_LOG = 1024 * 1024

# addrs.json only used to be written once, by start.cmd, at boot.  The campus RA
# prefix rotates every few hours, so by mid-day the phone page was handing out
# addresses that no longer existed -- which looks exactly like "sometimes it
# connects, sometimes it doesn't".  Refresh it from here, where a long-lived
# process already exists, instead of adding a scheduled task.
REFRESH_EVERY = 300.0


def log(msg: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        if os.path.exists(LOG) and os.path.getsize(LOG) > MAX_LOG:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


async def wait_dashboard(timeout: float = 60.0) -> bool:
    """Block until [::1]:PORT accepts, so the bridge's first upstream dial works."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r, w = await asyncio.wait_for(
                asyncio.open_connection("::1", PORT), timeout=1.5)
            w.close()
            return True
        except Exception:
            await asyncio.sleep(1.0)
    return False


def refresh_addrs() -> None:
    """Rewrite addrs.json from the live NIC state.  Never raises."""
    ps = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                      "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if not os.path.exists(ps):
        log("跳过地址刷新：找不到 %s" % ps)
        return
    if not os.path.exists(ADDRS_PS1):
        log("跳过地址刷新：%s 不在" % ADDRS_PS1)
        return
    flags = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW：别每 5 分钟弹一次黑框
    try:
        r = subprocess.run(
            [ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ADDRS_PS1],
            cwd=HERE, capture_output=True, text=True, timeout=90, creationflags=flags)
    except Exception as e:                        # noqa: BLE001 - 自愈进程不许死
        log("刷新 addrs.json 失败：%s" % e)
        return
    heads = [l.strip() for l in (r.stdout or "").splitlines() if "Phone:" in l][:2]
    if r.returncode == 0:
        log("刷新 addrs.json 完成 rc=0 %s" % ("| " + " / ".join(heads) if heads else ""))
    else:
        log("刷新 addrs.json rc=%s stderr=%s" % (r.returncode, (r.stderr or "").strip()[:180]))


def refresh_loop(stop: "threading.Event") -> None:
    while not stop.is_set():
        refresh_addrs()
        stop.wait(REFRESH_EVERY)


def main() -> int:
    if not os.path.exists(BRIDGE):
        log("FATAL ipv4_bridge.py 不在 %s" % HERE)
        return 1

    log("supervisor 启动，等 dashboard [::1]:%d 就绪…" % PORT)
    if not asyncio.run(wait_dashboard()):
        log("dashboard 60 秒内没起来 —— 仍然起桥，但它连不上会报错")
    else:
        log("dashboard 已就绪")

    # 桥跑起来之前先刷一次，让 start.cmd 那次可能已过期的地址立刻归位
    stop = threading.Event()
    threading.Thread(target=refresh_loop, args=(stop,),
                     name="addrs-refresher", daemon=True).start()
    log("地址保鲜已开：每 %.0f 秒重写 addrs.json" % REFRESH_EVERY)

    backoff = 1.0
    while True:
        started = time.monotonic()
        log("起 ipv4_bridge.py %d" % PORT)
        p = subprocess.run([sys.executable, BRIDGE, str(PORT)])
        lived = time.monotonic() - started
        if p.returncode == 0:
            log("桥正常退出（端口已被别的监听者服务）—— supervisor 收工")
            return 0
        # 只活了几秒就崩，多半是端口/权限问题，别疯狂重启
        backoff = 1.0 if lived > 30 else min(backoff * 2, 30.0)
        log("桥异常退出 rc=%s，活了 %.0fs，%.0fs 后重启" % (p.returncode, lived, backoff))
        time.sleep(backoff)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
