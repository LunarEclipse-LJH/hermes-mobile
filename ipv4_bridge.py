"""IPv4 -> IPv6 TCP bridge for the Hermes dashboard.

Why this exists
---------------
On Windows an ``AF_INET6`` socket created by asyncio/uvicorn for host ``::``
keeps the OS default ``IPV6_V6ONLY=1``.  The dashboard therefore binds
``[::]:9119`` only: every IPv4 address on this machine refuses the connection,
including ``127.0.0.1``, the hotspot gateway ``192.168.137.1`` and the campus
CGNAT address.  A phone tethered to the laptop's own hotspot has IPv4 only, so
it can never reach the dashboard no matter what address it is given.

This process binds ``0.0.0.0:PORT`` (legal at the same time as ``[::]:PORT``
precisely because the IPv6 socket is v6-only) and pumps bytes to ``[::1]:PORT``.
It is a dumb TCP relay on purpose:

* the WebSocket upgrade, the one-time ticket handshake and multi-MB frames all
  cross it unchanged -- nothing above L4 is parsed;
* the gateway sees the peer as loopback, so ``ws_client_reason`` and the
  Host/Origin guard treat it exactly like the desktop client;
* no TLS, no auth of its own: it exposes nothing the IPv6 socket does not
  already expose, and it dies with the console window that started it.

Usage: python ipv4_bridge.py [port]
"""

import asyncio
import os
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9119
TARGET = ("::1", PORT)
CHUNK = 65536
LOGDIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.dirname(os.path.abspath(__file__))),
                      "hermes", "logs")
LOG = os.path.join(LOGDIR, "hermes-mobile-bridge.log")


def _log(msg: str) -> None:
    """Print and append to the shared log — this process runs headless, so its
    only evidence trail is this file."""
    line = time.strftime("%Y-%m-%d %H:%M:%S [bridge] ") + msg
    print(line, flush=True)
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Copy one direction until EOF, then half-close the peer."""
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    except Exception:
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except Exception:
            pass


async def _handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    peer = client_w.get_extra_info("peername")
    try:
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(*TARGET), timeout=5)
    except Exception as exc:  # dashboard not up yet, or IPv6 stack down
        _log(f"cannot reach {TARGET[0]}:{TARGET[1]} for {peer}: {exc}")
        client_w.close()
        return
    try:
        await asyncio.gather(_pump(client_r, up_w), _pump(up_r, client_w))
    finally:
        for w in (up_w, client_w):
            try:
                w.close()
            except Exception:
                pass


async def _already_serving() -> bool:
    """True if something on 127.0.0.1:PORT already relays for us.

    Two bridges cannot share the port, but a second one is harmless — the
    point is to exit 0 quietly instead of looking like a crash, while a port
    held by an unrelated program must be reported loudly.
    """
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", PORT), timeout=2)
        w.close()
        return True
    except Exception:
        return False


async def _main() -> int:
    try:
        server = await asyncio.start_server(_handle, "0.0.0.0", PORT, backlog=128)
    except OSError as exc:
        if await _already_serving():
            _log(f"0.0.0.0:{PORT} 已有监听者（多半是另一个桥）—— 本进程退出，rc=0")
            return 0
        _log(f"FATAL 绑不上 0.0.0.0:{PORT}（{exc}），而该端口也没有服务在响应 —— "
             f"IPv4 客户端（热点）会连不上")
        return 2
    _log(f"listening 0.0.0.0:{PORT} -> [{TARGET[0]}]:{PORT}")
    async with server:
        await server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(_main()))
    except KeyboardInterrupt:
        sys.exit(0)
