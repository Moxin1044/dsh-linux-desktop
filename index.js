/**
 * dsh-linux-desktop — 把 Linux 桌面的「看屏幕」和「动鼠标键盘」包成 DSH 工具。
 *
 * 两条底层路径都是刻意选的，不是随便找了个工具：
 *   截图 → xdg-desktop-portal Screenshot。GNOME Wayland 下 org.gnome.Shell.Screenshot
 *          对普通客户端返回 AccessDenied，grim 要 wlr-screencopy，gnome-screenshot 已退场。
 *   输入 → ydotool，走内核 /dev/uinput。xdotool 只能驱动 XWayland 窗口，原生 Wayland
 *          窗口点不到；uinput 是合成器之下的一层，Wayland 原生窗口同样生效。
 *
 * 前提：ydotoold 在跑（systemctl --user enable --now ydotool），用户对 /dev/uinput 有写权限。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_SCRIPT = join(HERE, 'portal-shot.py')
const SHOT_DIR = join(homedir(), '.dsh', 'screenshots')
const YDOTOOL = '/usr/bin/ydotool'

/** 会话总线/运行时目录：DSH 可能从没有图形环境的 shell 起来，这里补齐。 */
function graphicalEnv() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir }
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`
  }
  return env
}

async function run(command, args, { timeout = 20000, env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: env || graphicalEnv(),
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || String(error)
    return { ok: false, stdout: error?.stdout || '', stderr: detail, code: error?.code }
  }
}

async function ydotool(args, timeout = 20000) {
  return run(YDOTOOL, args, { timeout })
}

/**
 * Linux input-event-codes.h 里 US 布局的常用键码。
 * ydotool key 收的是原始键码而不是键名，所以这张表是必要的转译层。
 */
const KEYCODES = {
  esc: 1, escape: 1,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, equal: 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  leftbrace: 26, rightbrace: 27, enter: 28, return: 28,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  semicolon: 39, apostrophe: 40, grave: 41, backslash: 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  comma: 51, dot: 52, slash: 53,
  space: 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108,
  pagedown: 109, insert: 110, delete: 111,
  leftmeta: 125, rightmeta: 126,
}

const MODIFIERS = {
  ctrl: 29, control: 29, leftctrl: 29, rightctrl: 97,
  alt: 56, leftalt: 56, rightalt: 100,
  shift: 42, leftshift: 42, rightshift: 54,
  meta: 125, super: 125, win: 125, cmd: 125, leftmeta: 125, rightmeta: 126,
}

/** 把 "ctrl+shift+t" 拆成键码序列；未知键名返回 null，由调用方报错。 */
function parseCombo(combo) {
  const parts = String(combo).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return null
  const codes = []
  for (const part of parts) {
    const code = MODIFIERS[part] ?? KEYCODES[part]
    if (typeof code !== 'number') return null
    codes.push(code)
  }
  return codes
}

const BUTTON_MASK = { left: '0xC0', right: '0xC1', middle: '0xC2' }
const BUTTON_DOWN = { left: '0x40', right: '0x41', middle: '0x42' }
const BUTTON_UP = { left: '0x80', right: '0x81', middle: '0x82' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 指针坐标换算。
 *
 * 坑在这里：ydotool 的 `mousemove --absolute` 收的是 **0–65535 的原始 ABS 轴值**，
 * 不是像素。直接传像素会全部挤到左上角（2600px 只占满范围的 4%），轻则点空，
 * 重则命中左上角热区把 GNOME 概览拉出来。
 *
 * 合成器把 0–65535 线性铺满整个逻辑桌面，而逻辑桌面 = 物理尺寸 / 缩放，
 * 所以 raw = px / 物理尺寸 × 65535 —— 缩放因子在推导中约掉了，只需要截图尺寸。
 */
let screenSize = null

async function getScreenSize({ refresh = false } = {}) {
  if (screenSize && !refresh) return screenSize
  // 截一张只为拿尺寸；拿完就删，不留垃圾文件。
  const probe = await captureScreen(`screen-size-${Date.now()}`)
  if (!probe.ok || !probe.width) return screenSize
  screenSize = { width: probe.width, height: probe.height }
  await unlink(probe.path).catch(() => {})
  return screenSize
}

/** 截图坐标（像素）→ ydotool 的原始轴值。 */
async function toRawAxis(px, py) {
  const size = await getScreenSize()
  if (!size) throw new Error('拿不到屏幕尺寸，无法换算指针坐标（截图失败？）')
  const clamp = (value, max) => Math.min(Math.max(Math.round(value), 0), max)
  return {
    x: clamp((px / size.width) * 65535, 65535),
    y: clamp((py / size.height) * 65535, 65535),
    size,
  }
}

/** 移动指针到截图坐标（像素）。 */
async function moveTo(px, py) {
  const raw = await toRawAxis(px, py)
  if (px < 0 || py < 0 || px >= raw.size.width || py >= raw.size.height) {
    return { ok: false, message: `坐标 (${px}, ${py}) 超出屏幕范围 ${raw.size.width}x${raw.size.height}` }
  }
  const moved = await ydotool(['mousemove', '--absolute', String(raw.x), String(raw.y)])
  return moved.ok ? { ok: true, raw } : { ok: false, message: moved.stderr }
}

// ---------------------------------------------------------------------------

/** 从 PNG 的 IHDR 直接读宽高，省掉一个图像库依赖。 */
async function pngSize(path) {
  const head = (await readFile(path)).subarray(0, 24)
  if (head.length < 24 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return { width: null, height: null }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/**
 * @param {string} [fileName]
 * @param {{ interactive?: boolean }} [options] interactive 交给 GNOME 自己的选区界面，按用户的框选出图
 */
async function captureScreen(fileName, options = {}) {
  if (!existsSync(SHOT_SCRIPT)) {
    return { ok: false, message: `截图脚本缺失：${SHOT_SCRIPT}` }
  }
  await mkdir(SHOT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const target = join(SHOT_DIR, fileName ? `${basename(String(fileName))}.png` : `shot-${stamp}.png`)

  const scriptArgs = [SHOT_SCRIPT]
  if (options.interactive) scriptArgs.push('--interactive')
  scriptArgs.push(target)

  // 交互选区要等用户拖框，给足时间；非交互有 30s 硬上限。
  const result = await run('python3', scriptArgs, { timeout: options.interactive ? 120000 : 45000 })
  if (!result.ok) {
    return { ok: false, message: `portal 截图失败：${result.stderr}` }
  }
  try {
    const info = JSON.parse(result.stdout.trim().split('\n').pop())
    return { ok: true, path: info.path, width: info.width, height: info.height, message: `已截图 ${info.width}x${info.height} → ${info.path}` }
  } catch (error) {
    return { ok: false, message: `portal 返回无法解析：${result.stdout}` }
  }
}

/** 用 ffmpeg 裁一块出来（系统上 ffmpeg 本来就装了，不必再引入图像库）。 */
async function cropRegion(srcPath, outPath, { x, y, width, height }) {
  const filter = `crop=${width}:${height}:${x}:${y}`
  const result = await run('ffmpeg', [
    '-y', '-v', 'error', '-i', srcPath,
    '-vf', filter, '-frames:v', '1', outPath,
  ], { timeout: 30000 })
  if (!result.ok) return { ok: false, message: `裁剪失败：${result.stderr}` }
  return { ok: true, path: outPath }
}

function registerToolWhenReady(ctx, label, register) {
  const attempt = () => {
    try {
      register()
      return true
    } catch (error) {
      if (/duplicate/i.test(String(error?.message || error))) return true
      const text = `[dsh-linux-desktop] ${label} 注册失败：${error?.message || error}`
      console.error(text)
      try { ctx.logger?.error?.(text) } catch { /* logger 缺席不连坐 */ }
      return false
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], () => { attempt() })
      return
    } catch { /* 退回同步注册 */ }
  }
  attempt()
}

export const name = 'dsh-linux-desktop'
export const inject = ['tools']

export function apply(ctx) {
  // ---- 截图 ----
  registerToolWhenReady(ctx, 'desktop_screenshot', () => ctx.tools.register(defineTool({
    name: 'desktop_screenshot',
    description: '截取 Linux 桌面画面（走 xdg-desktop-portal，GNOME Wayland 可用），返回图片和保存路径。'
      + '默认全屏；给 x/y/width/height 就只截那块矩形；interactive=true 则弹出系统选区界面让你自己框。'
      + '看不到屏幕内容时先用它；坐标类操作前也建议先截一张确认布局。',
    parameters: {
      name: { type: 'string', description: '可选。保存的文件名（不含 .png），不给就用时间戳' },
      x: { type: 'integer', description: '可选。局部截图左上角横坐标（像素）' },
      y: { type: 'integer', description: '可选。局部截图左上角纵坐标（像素）' },
      width: { type: 'integer', description: '可选。局部截图宽度（像素）' },
      height: { type: 'integer', description: '可选。局部截图高度（像素）' },
      interactive: { type: 'boolean', description: '可选。true 时由你在桌面上框选区域（GNOME 自己那套选区界面），此时忽略 x/y/width/height' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          message: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: true,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.message }]
        if (value.image?.attachmentId) {
          blocks.push({ type: 'image', attachment: { ...value.image } })
        }
        return blocks
      },
    },
    async execute(args) {
      const regionKeys = ['x', 'y', 'width', 'height']
      const given = regionKeys.filter((key) => Number.isInteger(args[key]))
      if (given.length > 0 && given.length < 4) {
        return { ok: false, message: `局部截图需要 x、y、width、height 四个都给齐，现在只给了 ${given.join('、')}` }
      }
      if (given.length === 4 && (args.width <= 0 || args.height <= 0)) {
        return { ok: false, message: 'width / height 必须大于 0' }
      }

      const interactive = args.interactive === true
      const shot = await captureScreen(args.name, { interactive })
      // 截图尺寸就是指针换算的基准，顺手刷新缓存（换分辨率/缩放后自动跟上）
      if (shot.ok && shot.width) screenSize = { width: shot.width, height: shot.height }
      if (!shot.ok) return shot

      let final = shot
      if (given.length === 4 && !interactive) {
        const { x, y, width, height } = args
        if (x < 0 || y < 0) return { ok: false, message: `x / y 不能为负（屏幕 ${shot.width}x${shot.height}）` }
        if (x + width > shot.width || y + height > shot.height) {
          return { ok: false, message: `区域超出屏幕：${x},${y} ${width}x${height} 超出 ${shot.width}x${shot.height}` }
        }
        const cropped = join(SHOT_DIR, `${basename(shot.path, '.png')}-crop.png`)
        const result = await cropRegion(shot.path, cropped, { x, y, width, height })
        if (!result.ok) return result
        const size = await pngSize(cropped)
        final = {
          ok: true,
          path: cropped,
          width: size.width,
          height: size.height,
          message: `已截取区域 ${x},${y} ${width}x${height}（屏幕 ${shot.width}x${shot.height}）→ ${cropped}`,
        }
      } else if (interactive) {
        final = { ...shot, message: `已按你的框选截图 ${shot.width}x${shot.height} → ${shot.path}` }
      }

      // 有 attachments 服务就把图挂成真正的图片块；没有就退化成路径文本。
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
        if (service?.saveImages) {
          const data = await readFile(final.path)
          const [ref] = await service.saveImages([{ data, mediaType: 'image/png', name: basename(final.path) }])
          if (ref?.attachmentId) {
            return { ...final, image: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height } }
          }
        }
      } catch (error) {
        console.error(`[dsh-linux-desktop] 图片附件化失败，退化为路径：${error?.message || error}`)
      }
      return final
    },
  })))

  // ---- 点击 ----
  registerToolWhenReady(ctx, 'desktop_click', () => ctx.tools.register(defineTool({
    name: 'desktop_click',
    description: '在屏幕上点击鼠标（走 ydotool/uinput，Wayland 原生窗口同样有效）。'
      + '给 x/y 会先做绝对定位再点击；不给就点当前光标位置。坐标单位是屏幕像素，原点在左上角。',
    parameters: {
      x: { type: 'integer', description: '可选。目标横坐标（像素）' },
      y: { type: 'integer', description: '可选。目标纵坐标（像素）' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '可选。默认 left' },
      times: { type: 'integer', description: '可选。连击次数，默认 1；2 就是双击' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const button = args.button || 'left'
      const times = Number.isInteger(args.times) && args.times > 0 ? args.times : 1
      const hasPoint = Number.isInteger(args.x) && Number.isInteger(args.y)

      if (hasPoint) {
        const moved = await moveTo(args.x, args.y)
        if (!moved.ok) return { ok: false, message: `移动到 (${args.x}, ${args.y}) 失败：${moved.message}` }
        await sleep(120) // 合成器需要一帧来更新命中测试，立刻点击容易点到上一个位置
      }

      const clickArgs = ['click']
      if (times > 1) clickArgs.push('--repeat', String(times))
      clickArgs.push(BUTTON_MASK[button] || BUTTON_MASK.left)

      const clicked = await ydotool(clickArgs)
      if (!clicked.ok) return { ok: false, message: `点击失败：${clicked.stderr}` }

      const where = hasPoint ? `(${args.x}, ${args.y})` : '当前光标位置'
      return { ok: true, message: `已在 ${where} ${button === 'left' ? '单击' : button} ${times > 1 ? `${times} 次` : '一次'}` }
    },
  })))

  // ---- 移动光标 ----
  registerToolWhenReady(ctx, 'desktop_move', () => ctx.tools.register(defineTool({
    name: 'desktop_move',
    description: '把鼠标光标移到指定坐标，**不点击**。悬停看提示、展开菜单、避免误触时用它；要点击请用 desktop_click。',
    parameters: {
      x: { type: 'integer', description: '目标横坐标（像素）', required: true },
      y: { type: 'integer', description: '目标纵坐标（像素）', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const moved = await moveTo(args.x, args.y)
      if (!moved.ok) return { ok: false, message: `移动失败：${moved.message}` }
      return { ok: true, message: `光标已移到 (${args.x}, ${args.y})` }
    },
  })))

  // ---- 拖拽 ----
  registerToolWhenReady(ctx, 'desktop_drag', () => ctx.tools.register(defineTool({
    name: 'desktop_drag',
    description: '按住鼠标从一点拖到另一点（拖窗口、拖文件、框选）。坐标单位是屏幕像素。',
    parameters: {
      fromX: { type: 'integer', description: '起点横坐标', required: true },
      fromY: { type: 'integer', description: '起点纵坐标', required: true },
      toX: { type: 'integer', description: '终点横坐标', required: true },
      toY: { type: 'integer', description: '终点纵坐标', required: true },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '可选。默认 left' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const button = args.button || 'left'
      const step = async (command, label) => {
        const result = await ydotool(command)
        if (!result.ok) throw new Error(`${label}失败：${result.stderr}`)
      }

      try {
        const start = await moveTo(args.fromX, args.fromY)
        if (!start.ok) throw new Error(`移动到起点失败：${start.message}`)
        await sleep(120)
        await step(['click', BUTTON_DOWN[button] || BUTTON_DOWN.left], '按下')
        // 分几步走：一步跳到终点，很多应用不认这是一次拖拽
        const steps = 8
        for (let i = 1; i <= steps; i += 1) {
          const x = Math.round(args.fromX + ((args.toX - args.fromX) * i) / steps)
          const y = Math.round(args.fromY + ((args.toY - args.fromY) * i) / steps)
          const hop = await moveTo(x, y)
          if (!hop.ok) throw new Error(`拖动失败：${hop.message}`)
          await sleep(40)
        }
        await step(['click', BUTTON_UP[button] || BUTTON_UP.left], '松开')
      } catch (error) {
        try { await ydotool(['click', BUTTON_UP[button] || BUTTON_UP.left]) } catch { /* 尽力松开 */ }
        return { ok: false, message: error.message }
      }
      return { ok: true, message: `已从 (${args.fromX}, ${args.fromY}) 拖到 (${args.toX}, ${args.toY})` }
    },
  })))

  // ---- 打字 ----
  registerToolWhenReady(ctx, 'desktop_type', () => ctx.tools.register(defineTool({
    name: 'desktop_type',
    description: '把文本输入到当前焦点窗口。ASCII 走 ydotool 逐字输入；含中文等非 ASCII 时自动改用'
      + '剪贴板 + Ctrl+V（会覆盖剪贴板内容）。需要先让目标输入框拿到焦点，否则别用。',
    parameters: {
      text: { type: 'string', description: '要输入的文本', required: true },
      mode: { type: 'string', enum: ['auto', 'type', 'paste'], description: '可选。默认 auto：纯 ASCII 用 type，否则用 paste' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' }, mode: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const text = String(args.text ?? '')
      if (!text) return { ok: false, message: 'text 为空' }
      const asciiOnly = !/[^\x00-\x7F]/.test(text)
      const mode = args.mode === 'type' || args.mode === 'paste'
        ? args.mode
        : (asciiOnly ? 'type' : 'paste')

      if (mode === 'type') {
        // ydotool type 不认换行，按行拆开，用 Enter 连接
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]) {
            const typed = await ydotool(['type', '--', lines[i]], 30000)
            if (!typed.ok) return { ok: false, mode, message: `输入失败：${typed.stderr}` }
          }
          if (i < lines.length - 1) {
            const entered = await ydotool(['key', '28:1', '28:0'])
            if (!entered.ok) return { ok: false, mode, message: `回车失败：${entered.stderr}` }
          }
        }
        return { ok: true, mode, message: `已输入 ${text.length} 个字符（逐字）` }
      }

      const copied = await run('wl-copy', ['--', text])
      if (!copied.ok) {
        return { ok: false, mode, message: `写入剪贴板失败（需要 wl-clipboard）：${copied.stderr}` }
      }
      await sleep(150)
      const pasted = await ydotool(['key', '29:1', '47:1', '47:0', '29:0'])
      if (!pasted.ok) return { ok: false, mode, message: `Ctrl+V 失败：${pasted.stderr}` }
      return { ok: true, mode, message: `已通过剪贴板粘贴 ${text.length} 个字符（原剪贴板内容已被覆盖）` }
    },
  })))

  // ---- 按键/快捷键 ----
  registerToolWhenReady(ctx, 'desktop_key', () => ctx.tools.register(defineTool({
    name: 'desktop_key',
    description: '按一个键或组合键，如 "enter"、"esc"、"ctrl+c"、"alt+tab"、"ctrl+shift+t"、'
      + '"super"（打开 GNOME 概览）。键名用 US 布局的小写名。',
    parameters: {
      combo: { type: 'string', description: '组合键，用 + 连接，如 ctrl+alt+t', required: true },
      times: { type: 'integer', description: '可选。重复次数，默认 1' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const codes = parseCombo(args.combo)
      if (!codes) return { ok: false, message: `无法识别的键名：${args.combo}` }
      const times = Number.isInteger(args.times) && args.times > 0 ? args.times : 1

      const sequence = []
      for (let i = 0; i < times; i += 1) {
        for (const code of codes) sequence.push(`${code}:1`)
        for (const code of [...codes].reverse()) sequence.push(`${code}:0`)
      }
      const pressed = await ydotool(['key', ...sequence])
      if (!pressed.ok) return { ok: false, message: `按键失败：${pressed.stderr}` }
      return { ok: true, message: `已按 ${args.combo}${times > 1 ? ` ×${times}` : ''}` }
    },
  })))
}
