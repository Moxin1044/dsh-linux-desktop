#!/usr/bin/env python3
"""用 /dev/uinput 直接建一只「绝对定位鼠标」并执行一串指针动作。

为什么不用 ydotool：`ydotoold` 建出来的虚拟设备只有 EV_REL/EV_KEY，
**没有 EV_ABS**，所以 `ydotool mousemove --absolute` 发出的绝对事件会被内核
直接丢弃——指针根本不动。`ydotoold -T`（--touch-on）本该补上 EV_ABS，
但这个版本启动即退出（rc=2）。

这里用 QEMU usb-tablet 的同款模型：EV_ABS(ABS_X/ABS_Y) + EV_KEY(BTN_*)，
libinput 会把它认成绝对定位指针，坐标 0..65535 线性铺满整个逻辑桌面。

用法: pointer.py '<json 动作列表>'
  [{"type":"move","x":0,"y":0},          # x/y 为 0..65535 轴值
   {"type":"button","button":"left","action":"down"},
   {"type":"button","button":"left","action":"up"},
   {"type":"wheel","amount":-1}]
"""
import ctypes
import fcntl
import json
import struct
import sys
import time

UINPUT_PATH = "/dev/uinput"

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
SYN_REPORT = 0
ABS_X, ABS_Y = 0x00, 0x01
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
REL_WHEEL = 0x08
BUTTON_CODE = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}

UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
ABS_MAX = 65535


def _iow(nr, size):
    return (1 << 30) | (size << 16) | (0x55 << 8) | nr


UI_SET_EVBIT = _iow(100, 4)
UI_SET_KEYBIT = _iow(101, 4)
UI_SET_RELBIT = _iow(102, 4)
UI_SET_ABSBIT = _iow(103, 4)


class InputAbsInfo(ctypes.Structure):
    _fields_ = [
        ("value", ctypes.c_int32),
        ("minimum", ctypes.c_int32),
        ("maximum", ctypes.c_int32),
        ("fuzz", ctypes.c_int32),
        ("flat", ctypes.c_int32),
        ("resolution", ctypes.c_int32),
    ]


class UinputAbsSetup(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("absinfo", InputAbsInfo)]


class InputId(ctypes.Structure):
    _fields_ = [
        ("bustype", ctypes.c_uint16),
        ("vendor", ctypes.c_uint16),
        ("product", ctypes.c_uint16),
        ("version", ctypes.c_uint16),
    ]


class UinputSetup(ctypes.Structure):
    _fields_ = [
        ("id", InputId),
        ("name", ctypes.c_char * 80),
        ("ff_effect_max", ctypes.c_uint32),
    ]


def ioctl(fd, request, arg=0):
    """fcntl.ioctl 只接受 int 或 bytes-like，ctypes 结构体要先转成字节。"""
    fcntl.ioctl(fd, request, bytes(arg) if isinstance(arg, ctypes.Structure) else arg)


def emit(fd, etype, code, value):
    now = time.time()
    sec = int(now)
    usec = int((now - sec) * 1_000_000)
    fd.write(struct.pack("llHHi", sec, usec, etype, code, value))


def create_device(fd, name):
    ioctl(fd, UI_SET_EVBIT, EV_KEY)
    ioctl(fd, UI_SET_EVBIT, EV_ABS)
    ioctl(fd, UI_SET_EVBIT, EV_REL)
    ioctl(fd, UI_SET_EVBIT, EV_SYN)
    for code in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
        ioctl(fd, UI_SET_KEYBIT, code)
    ioctl(fd, UI_SET_RELBIT, REL_WHEEL)

    for axis in (ABS_X, ABS_Y):
        ioctl(fd, UI_SET_ABSBIT, axis)
        setup = UinputAbsSetup()
        setup.code = axis
        setup.absinfo.minimum = 0
        setup.absinfo.maximum = ABS_MAX
        setup.absinfo.fuzz = 0
        setup.absinfo.flat = 0
        setup.absinfo.resolution = 0
        ioctl(fd, _iow(4, ctypes.sizeof(UinputAbsSetup)), setup)

    dev = UinputSetup()
    dev.id = InputId(0x03, 0x2333, 0x6667, 1)  # BUS_USB
    dev.name = name.encode()[:79]
    ioctl(fd, _iow(3, ctypes.sizeof(UinputSetup)), dev)
    ioctl(fd, UI_DEV_CREATE)


def main():
    actions = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    fd = open(UINPUT_PATH, "wb", buffering=0)
    try:
        create_device(fd, "dsh-linux-desktop pointer")
        time.sleep(0.2)  # 等设备注册完成，太早写事件会丢

        for action in actions:
            kind = action.get("type")
            if kind == "move":
                emit(fd, EV_ABS, ABS_X, max(0, min(ABS_MAX, int(action["x"]))))
                emit(fd, EV_ABS, ABS_Y, max(0, min(ABS_MAX, int(action["y"]))))
            elif kind == "button":
                code = BUTTON_CODE[action.get("button", "left")]
                emit(fd, EV_KEY, code, 1 if action.get("action") == "down" else 0)
            elif kind == "wheel":
                emit(fd, EV_REL, REL_WHEEL, int(action.get("amount", 0)))
            emit(fd, EV_SYN, SYN_REPORT, 0)
            time.sleep(action.get("delay", 0.03))

        time.sleep(0.05)
    finally:
        try:
            ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        fd.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
