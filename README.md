# dsh-linux-desktop

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 Linux 桌面自动化插件：**看屏幕** + **动鼠标键盘**，在 GNOME / KDE 的 **Wayland 会话下可用**（X11 当然也可以）。

别的同类方案大多卡在 xdotool 上——它只能驱动 XWayland 窗口，原生 Wayland 窗口点不到。这个插件换了两条更底层的路。

## 为什么是这两条路

| 能力 | 用的东西 | 为什么不用别的 |
|---|---|---|
| 截图 | `xdg-desktop-portal` 的 `Screenshot` 接口 | GNOME Wayland 下 `org.gnome.Shell.Screenshot` 对普通客户端返回 `AccessDenied`；`grim` 需要 wlr-screencopy（GNOME 不支持）；`gnome-screenshot` 已随 GNOME 45 退场 |
| 鼠标键盘 | `ydotool`（内核 `/dev/uinput`） | `xdotool` 只能驱动 XWayland 窗口，原生 Wayland 窗口点不到；`uinput` 在合成器之下，Wayland 原生窗口同样生效 |

## 工具

| 工具 | 作用 |
|---|---|
| `desktop_screenshot` | 全屏截图；给 `x/y/width/height` 只截那块矩形；`interactive: true` 弹出系统选区界面让你自己框 |
| `desktop_move` | 只移光标，不点击。悬停看提示、展开菜单、避让时用 |
| `desktop_click` | 在 `(x, y)` 点击（可双击、右键、中键）；不给坐标就点当前光标位置 |
| `desktop_drag` | 从一点按住拖到另一点（8 段插值，否则很多应用不认） |
| `desktop_type` | 输入文本。纯 ASCII 逐字输入；含中文等非 ASCII 自动改走剪贴板 + Ctrl+V（会覆盖剪贴板） |
| `desktop_key` | 组合键，如 `ctrl+c`、`alt+tab`、`super`、`ctrl+shift+t` |

坐标都是屏幕像素，原点在左上角，和 `desktop_screenshot` 出图同尺寸。

## 依赖

```sh
# 输入：ydotoold 常驻，负责往 /dev/uinput 写
systemctl --user enable --now ydotool

# 截图：python3 + PyGObject（GNOME 桌面本来就有），裁剪：ffmpeg
```

用户需要对 `/dev/uinput` 有写权限。Arch 的 `ydotool` 包自带 uaccess 规则；其他发行版可能要加 udev 规则或把用户加进 `uinput` 组。

## 安装

从 GitHub 直接装：

```sh
dsh plugin --profile web add github:Moxin1044/dsh-linux-desktop
```

或者 clone 下来挂本地目录（改代码时方便）：

```sh
git clone https://github.com/Moxin1044/dsh-linux-desktop.git
dsh plugin --profile web add link:$PWD/dsh-linux-desktop
```

装完重启 dsh web 生效——host 插件不走 HMR。

## 用法示例

```text
帮我截个图看看现在屏幕上是什么
把屏幕上那个「保存」按钮附近 200x60 的区域截给我看
点一下 (640, 400)，双击
把光标移到 (100, 100) 别点
往输入框里打「你好，世界」
按 ctrl+shift+t
```

## 已知限制

- `desktop_type` 逐字输入只覆盖 US 布局可打印 ASCII；中文、emoji 一律走剪贴板粘贴。
- `desktop_key` 的键名是 US 布局表，没有的键名会明确报错，不会瞎按。
- 桌面处于锁屏时 portal 会拒绝或只拍到锁屏画面。
- Wayland 下**读不到当前光标位置**（没有对应协议），所以"移到某处再移回原处"做不到，只能移到已知坐标。
- 没有做多显示器区分：坐标是整个虚拟桌面空间的像素。

## License

MIT
