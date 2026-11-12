#!/usr/bin/env python3
"""xdg-desktop-portal 截图。

为什么不用别的：GNOME Wayland 下 org.gnome.Shell.Screenshot 对普通客户端返回
AccessDenied，grim 需要 wlr-screencopy，gnome-screenshot 已随 GNOME 45 退场。
portal 的 Screenshot 接口是唯一既非交互、又被桌面正式支持的路径。

用法: portal-shot.py <输出 PNG 绝对路径>
输出: {"path": "...", "width": W, "height": H}
"""
import json
import os
import shutil
import struct
import sys
import urllib.parse

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

PORTAL_DEST = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"


def png_size(path):
    """从 IHDR 直接读宽高，不依赖 Pillow。"""
    with open(path, "rb") as fh:
        head = fh.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None, None
    width, height = struct.unpack(">II", head[16:24])
    return width, height


def main():
    argv = sys.argv[1:]
    interactive = False
    if "--interactive" in argv:
        interactive = True
        argv.remove("--interactive")
    if len(argv) != 1:
        print("usage: portal-shot.py [--interactive] <out.png>", file=sys.stderr)
        return 2
    out_path = os.path.abspath(argv[0])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    state = {}
    loop = GLib.MainLoop()

    def on_response(_conn, _sender, _path, iface, signal, params, *_rest):
        if iface != "org.freedesktop.portal.Request" or signal != "Response":
            return
        code, options = params.unpack()
        state["code"] = code
        state["uri"] = options.get("uri", "")
        loop.quit()

    sub = bus.signal_subscribe(
        PORTAL_DEST, "org.freedesktop.portal.Request", "Response", None, None,
        Gio.DBusSignalFlags.NONE, on_response,
    )
    try:
        reply = bus.call_sync(
            PORTAL_DEST, PORTAL_PATH, "org.freedesktop.portal.Screenshot", "Screenshot",
            GLib.Variant("(sa{sv})", ("", {"interactive": GLib.Variant("b", interactive)})),
            GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 10000, None,
        )
    except GLib.Error as exc:
        print(f"portal call failed: {exc.message}", file=sys.stderr)
        return 3

    request_path = reply.unpack()[0]
    # 请求对象可能在上面 subscribe 之后才出现；按返回路径重新订阅，避免漏掉信号。
    bus.signal_unsubscribe(sub)
    sub = bus.signal_subscribe(
        PORTAL_DEST, "org.freedesktop.portal.Request", "Response", request_path, None,
        Gio.DBusSignalFlags.NONE, on_response,
    )

    def on_timeout():
        state.setdefault("timeout", True)
        loop.quit()
        return False

    GLib.timeout_add_seconds(30, on_timeout)
    loop.run()
    bus.signal_unsubscribe(sub)

    if state.get("timeout"):
        print("timed out waiting for the screenshot response", file=sys.stderr)
        return 4
    if state.get("code") != 0 or not state.get("uri"):
        print(f"portal denied or returned no file (code={state.get('code')})", file=sys.stderr)
        return 5

    src_path = urllib.parse.unquote(state["uri"].replace("file://", "", 1))
    shutil.copyfile(src_path, out_path)

    width, height = png_size(out_path)
    print(json.dumps({"path": out_path, "width": width, "height": height}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
