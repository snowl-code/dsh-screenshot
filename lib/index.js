/**
 * dsh-screenshot —— 宿主半侧
 *
 * 职责：
 *   1) 给页面一个「把当前屏幕截下来」的本地路由（桌面端 Electron 没有 display-media
 *      handler，所以 macOS 调系统 screencapture、Windows 调随包发布的 PowerShell 脚本）；
 *      Windows 下常驻一个预热好的 capture-agent.ps1（bin/win/capture-agent.ps1），
 *      避免每次截图都付 powershell.exe 那一秒多的冷启动；代理接不上时退回一次性脚本
 *      （bin/win/capture.ps1）。
 *   2) 支撑「系统级全局热键」：页面把快捷键目录里的当前键位 POST 过来，宿主据此
 *      启动随包发布的辅助程序（macOS: bin/dsh-hotkey，Windows: bin/win/hotkey.ps1）。
 *      辅助程序在 DSH 失焦时向系统注册热键，按下后向 stdout 打一行 TRIGGER；宿主收到后走同一套截图流程，
 *      把结果放进 pending 队列，页面轮询取走并塞进当前草稿。
 *
 * 路由（都挂在 /dsh-screenshot-capture 前缀下）：
 *   POST /capture   -> { ok, dataUrl, mime, name } | { ok:false, code, error }
 *   GET  /pending   -> { ok, items: [{ id, dataUrl, mime, name, at }] }
 *   POST /take      -> { ok, removed }          页面把已入草稿的截图确认掉
 *   POST /hotkey    -> { ok, active }           { keycode, mods } 或 { enabled: false }
 *   GET  /status    -> { ok, platform, active, lastTriggerAt, pending, agent }
 *
 * 截图先落在临时目录，再用 sips 压到长边 1800px 的 JPEG，随后立刻删掉临时目录，
 * 只把 base64 交给页面。页面拿到后自己造 File 丢进草稿附件。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'dsh-screenshot'

/** 宿主依赖：只需要本地 HTTP 服务器来挂路由。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-screenshot-capture'
const CAPTURE_PATH = `${ROUTE_PREFIX}/capture`
const PENDING_PATH = `${ROUTE_PREFIX}/pending`
const TAKE_PATH = `${ROUTE_PREFIX}/take`
const HOTKEY_PATH = `${ROUTE_PREFIX}/hotkey`
const STATUS_PATH = `${ROUTE_PREFIX}/status`
/** 页面侧必须带的自定义头：跨站请求会先撞 CORS 预检，从而拒绝掉。 */
const REQUIRED_HEADER = 'x-dsh-screenshot'
const REQUIRED_HEADER_VALUE = '1'
/** 单张截图 base64 上限（约 16MB）。 */
const MAX_DATA_URL_BYTES = 16 * 1024 * 1024
/** 截图最长边（像素）。太大既费 token 也费上传带宽。 */
const TARGET_MAX_EDGE = 1800
const FALLBACK_MAX_EDGE = 1280
const JPEG_QUALITY = '82'
/** 全局热键截图最多滞留几张；页面取走前一直保留。 */
const PENDING_LIMIT = 3
/** JSON body 上限。 */
const MAX_BODY_BYTES = 8192

const HELPER_PATH = fileURLToPath(new URL('../bin/dsh-hotkey', import.meta.url))
/** Windows 三个辅助脚本：框选截图（一次性兜底）、常驻截图代理、系统级热键。随包发布，不需要编译。 */
const WINDOWS_CAPTURE_SCRIPT = fileURLToPath(new URL('../bin/win/capture.ps1', import.meta.url))
const WINDOWS_AGENT_SCRIPT = fileURLToPath(new URL('../bin/win/capture-agent.ps1', import.meta.url))
const WINDOWS_HOTKEY_SCRIPT = fileURLToPath(new URL('../bin/win/hotkey.ps1', import.meta.url))
const POWERSHELL_COMMAND =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
/** DSH Desktop 的进程名（Windows 辅助程序用它判断 DSH 是否在前台）。 */
const APP_PROCESS_NAME =
  process.versions.electron === undefined ? '' : basename(process.execPath).replace(/\.exe$/i, '')

/** 串行化截图，避免连点时 screen 上叠两套选框。 */
let queue = Promise.resolve()

/** 待页面取走的全局热键截图。 */
const pendingCaptures = []
let pendingSequence = 0

/** 当前运行中的辅助程序。 */
let helperChild = null
/** 辅助程序最近输出的行（诊断用，/status 会带出来）。 */
const helperLog = []
const HELPER_LOG_LIMIT = 40
let helperKey = ''
let helperKind = ''
let lastTriggerAt = 0
let logger = console

// ---------------------------------------------------------------------------
// 键位映射：页面只上报抽象键位（如 { code: 'KeyS', modifiers: ['primary','alt'] }），
// 宿主按当前平台翻译成对应辅助程序要的虚拟键码与修饰键掩码。
// macOS 用 Carbon kVK_* 与 cmdKey/optionKey 等掩码，Windows 用 VK_* 与
// RegisterHotKey 的 MOD_* 位；primary 在 macOS 是 Command，在 Windows 是 Control。
// ---------------------------------------------------------------------------

/** macOS ANSI 虚拟键码（Carbon kVK_*）：键位录制器可能产出的按键都收进来。 */
const MAC_KEYCODES = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24,
  Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30,
  KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Return: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46,
  Period: 47, Tab: 48, Space: 49, Backquote: 50, Delete: 51, Escape: 53,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109,
  F11: 103, F12: 111
}

/** Carbon 修饰键掩码（与 Swift 辅助程序里的 cmdKey/optionKey 等一致）。 */
const MAC_MODIFIER_MASKS = { meta: 0x0100, shift: 0x0200, alt: 0x0800, control: 0x1000 }

/** Windows 虚拟键码（VK_*）。 */
const WINDOWS_VIRTUAL_KEYS = {
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46, KeyG: 0x47,
  KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4a, KeyK: 0x4b, KeyL: 0x4c, KeyM: 0x4d, KeyN: 0x4e,
  KeyO: 0x4f, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52, KeyS: 0x53, KeyT: 0x54, KeyU: 0x55,
  KeyV: 0x56, KeyW: 0x57, KeyX: 0x58, KeyY: 0x59, KeyZ: 0x5a,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
  F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b, F13: 0x7c, F14: 0x7d, F15: 0x7e, F16: 0x7f,
  F17: 0x80, F18: 0x81, F19: 0x82, F20: 0x83, F21: 0x84, F22: 0x85, F23: 0x86, F24: 0x87,
  Return: 0x0d, Tab: 0x09, Space: 0x20, Escape: 0x1b, Backspace: 0x08, Delete: 0x2e,
  Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf,
  Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde
}

/** RegisterHotKey 的修饰键位（MOD_ALT/MOD_CONTROL/MOD_SHIFT/MOD_WIN）。 */
const WINDOWS_MODIFIER_FLAGS = { alt: 0x0001, control: 0x0002, shift: 0x0004, meta: 0x0008 }

const MODIFIER_NAMES = new Set(['primary', 'alt', 'shift', 'control', 'meta'])
const MAC_KEYCODE_TO_CODE = new Map(Object.entries(MAC_KEYCODES).map(([code, keycode]) => [keycode, code]))

/**
 * 把页面 POST 过来的键位归一成抽象形态 { code, modifiers }。
 * 兼容 0.2.x 页面发来的旧形态 { keycode, mods }（macOS 虚拟键码 + Carbon 掩码）。
 */
export function hotkeySpecOf(body) {
  if (body === null || typeof body !== 'object') return null

  if (typeof body.code === 'string' && body.code !== '') {
    const modifiers = Array.isArray(body.modifiers)
      ? body.modifiers.filter((modifier) => MODIFIER_NAMES.has(modifier))
      : []
    const unique = [...new Set(modifiers)]
    return unique.length === 0 ? null : { code: body.code, modifiers: unique }
  }

  if (Number.isInteger(body.keycode) && Number.isInteger(body.mods)) {
    const code = MAC_KEYCODE_TO_CODE.get(body.keycode)
    if (code === undefined) return null
    const modifiers = []
    if ((body.mods & MAC_MODIFIER_MASKS.meta) !== 0) modifiers.push('primary')
    if ((body.mods & MAC_MODIFIER_MASKS.shift) !== 0) modifiers.push('shift')
    if ((body.mods & MAC_MODIFIER_MASKS.alt) !== 0) modifiers.push('alt')
    if ((body.mods & MAC_MODIFIER_MASKS.control) !== 0) modifiers.push('control')
    return modifiers.length === 0 ? null : { code, modifiers }
  }

  return null
}

/** 抽象键位 -> Swift 辅助程序参数；不支持的键返回 null。 */
export function darwinHotkeyOf(spec) {
  if (spec === null || typeof spec !== 'object') return null
  const keycode = MAC_KEYCODES[spec.code]
  if (typeof keycode !== 'number') return null
  let mods = 0
  for (const modifier of Array.isArray(spec.modifiers) ? spec.modifiers : []) {
    // 目录里的 binding 通常已经把 primary 展开成 meta；这里仍兼容抽象形态。
    const mask = modifier === 'primary' ? MAC_MODIFIER_MASKS.meta : MAC_MODIFIER_MASKS[modifier]
    if (typeof mask === 'number') mods |= mask
  }
  return mods === 0 ? null : { keycode, mods }
}

/** 抽象键位 -> Windows 辅助脚本参数；不支持的键返回 null。 */
export function windowsHotkeyOf(spec) {
  if (spec === null || typeof spec !== 'object') return null
  const vk = WINDOWS_VIRTUAL_KEYS[spec.code]
  if (typeof vk !== 'number') return null
  let mods = 0
  for (const modifier of Array.isArray(spec.modifiers) ? spec.modifiers : []) {
    if (modifier === 'primary') mods |= WINDOWS_MODIFIER_FLAGS.control
    else {
      const flag = WINDOWS_MODIFIER_FLAGS[modifier]
      if (typeof flag === 'number') mods |= flag
    }
  }
  return mods === 0 ? null : { vk, mods }
}

function enqueue(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function exists(path) {
  try {
    const info = await stat(path)
    return info.size > 0
  } catch {
    return false
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, ...result })
    }
    const timer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish({ code: null, timedOut: true })
    }, timeoutMs)
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish({ code: null, spawnError: true, stderr: String(error?.message ?? error) })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ code: null, stderr: `${stderr}${error?.message ?? error}`, spawnError: true }))
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

function fileNameOf(extension) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extension}`
}

/** 把任意尺寸的 PNG 压成 JPEG；失败就原样返回 PNG。 */
async function toJpeg(rawPath, dir, maxEdge) {
  const out = join(dir, `out-${maxEdge}.jpg`)
  const result = await run('/usr/bin/sips', ['-Z', String(maxEdge), '-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY, rawPath, '--out', out], 30_000)
  if (result.code === 0 && (await exists(out))) return { path: out, mime: 'image/jpeg', extension: 'jpg' }
  return { path: rawPath, mime: 'image/png', extension: 'png' }
}

/** macOS：调用系统 screencapture 交互框选，再用 sips 压成 JPEG。 */
async function captureDarwin(dir, rawPath) {
  // -i 交互框选（空格切窗口 / 拖拽选区 / Esc 取消），-x 不播放快门声
  const shot = await run('/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', rawPath], 10 * 60 * 1000)

  if (!(await exists(rawPath))) {
    const stderr = shot.stderr.trim()
    if (/could not create image/i.test(stderr) || shot.spawnError || shot.timedOut) {
      return {
        ok: false,
        code: 'permission',
        error:
          '截图失败：DSH 还没有「屏幕录制」权限。到 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 DSH Desktop，然后重启应用再试。'
      }
    }
    return { ok: false, code: 'cancelled', error: '已取消截图。' }
  }

  return toJpeg(rawPath, dir, TARGET_MAX_EDGE)
}

/**
 * 常驻截图代理。
 *
 * 本机实测：光起动 powershell.exe 就要 ~1.1 秒，加载 WinForms 到 ~1.4 秒，再编译 DPI
 * 声明到 ~1.5 秒。每次截图都 spawn 一个进程，就是「按快捷键/点图标要等很久」的全部原因。
 * 所以 Windows 下留一个预热好的 capture-agent.ps1，用 stdin 一行行下命令；预热后从收到
 * 命令到画出选框约 130 毫秒（2560x1440 整屏冻结 49ms + 建窗体 80ms）。
 */
let captureAgent = null
/** 代理从启动到 READY 的上限；超时视为坏掉，本次退回一次性脚本。 */
const AGENT_READY_TIMEOUT_MS = 20_000
/** 空闲多久回收代理，免得常驻一个 PowerShell 白占内存（约 45MB）。 */
const AGENT_IDLE_MS = 30 * 60 * 1000
/** 发 EXIT 后给它多久自己退，超时就 kill。 */
const AGENT_EXIT_GRACE_MS = 2000
/** 单次框选的最长等待（用户可以一直拖着不松手）。 */
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000

function stopCaptureAgent(target = captureAgent) {
  const agent = target
  if (agent === null || agent === undefined) return
  if (captureAgent === agent) captureAgent = null
  if (agent.idleTimer !== null) {
    clearTimeout(agent.idleTimer)
    agent.idleTimer = null
  }
  clearTimeout(agent.readyTimer)
  for (const waiter of agent.waiting.values()) waiter.reject(new Error('capture agent stopped'))
  agent.waiting.clear()
  try {
    agent.child?.stdin?.end('EXIT\n')
  } catch {
    /* 管道已经断了 */
  }
  const child = agent.child
  const timer = setTimeout(() => {
    try {
      child?.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }, AGENT_EXIT_GRACE_MS)
  timer.unref?.()
}

function scheduleAgentIdleStop(agent) {
  if (agent.idleTimer !== null) clearTimeout(agent.idleTimer)
  agent.idleTimer = setTimeout(() => {
    if (captureAgent === agent) stopCaptureAgent(agent)
  }, AGENT_IDLE_MS)
  agent.idleTimer.unref?.()
}

/** 代理意外退出/起不来：把等在队列里的请求全部判失败，并让下一次截图重新起一个。 */
function failCaptureAgent(agent, reason) {
  if (agent.dead) return
  agent.dead = true
  if (captureAgent === agent) captureAgent = null
  if (agent.idleTimer !== null) {
    clearTimeout(agent.idleTimer)
    agent.idleTimer = null
  }
  clearTimeout(agent.readyTimer)
  agent.rejectReady?.(new Error(reason))
  agent.rejectReady = null
  for (const waiter of agent.waiting.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error(reason))
  }
  agent.waiting.clear()
}

function settleAgent(agent, id, value) {
  const waiter = agent.waiting.get(id)
  if (waiter === undefined) return
  agent.waiting.delete(id)
  clearTimeout(waiter.timer)
  waiter.resolve(value)
}

function handleAgentLine(agent, line) {
  if (line === 'READY') {
    clearTimeout(agent.readyTimer)
    agent.readyAt = Date.now()
    agent.resolveReady?.(true)
    agent.resolveReady = null
    agent.rejectReady = null
    return
  }
  if (line === 'PONG') return

  const done = /^DONE (\S+) (\d+)x(\d+)$/.exec(line)
  if (done !== null) {
    settleAgent(agent, done[1], { ok: true, width: Number(done[2]), height: Number(done[3]) })
    return
  }
  const cancelled = /^CANCEL (\S+)$/.exec(line)
  if (cancelled !== null) {
    settleAgent(agent, cancelled[1], { ok: false, code: 'cancelled', error: '已取消截图。' })
    return
  }
  const failed = /^ERR (\S+)(?: (.*))?$/.exec(line)
  if (failed !== null) {
    const detail = (failed[2] ?? '').trim()
    settleAgent(agent, failed[1], {
      ok: false,
      code: 'failed',
      error: detail === '' ? '截图失败，请重试。' : `截图失败：${detail.slice(0, 200)}`
    })
    return
  }
  logger?.debug?.(`dsh-screenshot: 截图代理: ${line}`)
}

/** 起一个截图代理进程并挂好 stdout 行协议；调用方 await agent.ready。 */
function startCaptureAgent() {
  const agent = {
    child: null,
    dead: false,
    ready: null,
    readyAt: 0,
    readyTimer: null,
    idleTimer: null,
    waiting: new Map(),
    sequence: 0,
    buffer: '',
    resolveReady: null,
    rejectReady: null
  }
  agent.ready = new Promise((resolve, reject) => {
    agent.resolveReady = resolve
    agent.rejectReady = reject
  })
  // 失败由 await 的地方处理；这里挂个空 catch，避免「未处理的 rejection」告警。
  agent.ready.catch(() => {})

  let child
  try {
    child = spawn(POWERSHELL_COMMAND, [...POWERSHELL_FLAGS, '-STA', '-File', WINDOWS_AGENT_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    failCaptureAgent(agent, messageOf(error))
    return agent
  }
  agent.child = child
  child.stdin?.setDefaultEncoding?.('utf8')
  // 代理可能在两次截图之间退出：stdin 的 EPIPE 是异步事件，不挂监听会让宿主进程崩掉。
  child.stdin?.on('error', (error) => failCaptureAgent(agent, messageOf(error)))

  agent.readyTimer = setTimeout(() => {
    failCaptureAgent(agent, 'capture agent did not become ready')
    stopCaptureAgent(agent)
  }, AGENT_READY_TIMEOUT_MS)
  agent.readyTimer.unref?.()

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    agent.buffer += chunk
    let index = agent.buffer.indexOf('\n')
    while (index >= 0) {
      const line = agent.buffer.slice(0, index).replace(/\r$/, '').trim()
      agent.buffer = agent.buffer.slice(index + 1)
      if (line !== '') handleAgentLine(agent, line)
      index = agent.buffer.indexOf('\n')
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    logger?.debug?.(`dsh-screenshot: 截图代理 stderr: ${String(chunk).trim()}`)
  })
  child.on('error', (error) => failCaptureAgent(agent, messageOf(error)))
  child.on('exit', (code, signal) => {
    failCaptureAgent(agent, `capture agent exited (${code ?? signal})`)
  })

  return agent
}

/**
 * 走常驻代理截图。返回 null 表示「代理这次根本没接上」——调用方应退回一次性脚本；
 * 返回结果对象则表示请求已经交给代理，无论成败都不再重试（否则用户会看到第二个选框）。
 */
async function captureWindowsViaAgent(outPath) {
  if (captureAgent === null) {
    const agent = startCaptureAgent()
    if (agent.dead !== true) captureAgent = agent
  }
  const agent = captureAgent
  if (agent === null) return null

  try {
    await agent.ready
  } catch {
    return null
  }
  if (agent.dead === true) return null

  if (agent.idleTimer !== null) {
    clearTimeout(agent.idleTimer)
    agent.idleTimer = null
  }

  const id = String(++agent.sequence)
  let reply
  try {
    reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.waiting.delete(id)
        reject(new Error('截图代理响应超时'))
      }, CAPTURE_TIMEOUT_MS)
      agent.waiting.set(id, { resolve, reject, timer })
      try {
        agent.child.stdin.write(`CAPTURE ${id} ${TARGET_MAX_EDGE} ${JPEG_QUALITY} ${outPath}\n`)
      } catch (error) {
        agent.waiting.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  } catch (error) {
    return { ok: false, code: 'failed', error: `截图失败：${messageOf(error)}` }
  } finally {
    if (agent.dead !== true) scheduleAgentIdleStop(agent)
  }

  if (reply.ok !== true) return reply
  if (!(await exists(outPath))) return { ok: false, code: 'failed', error: '截图失败，请重试。' }
  return { path: outPath, mime: 'image/jpeg', extension: 'jpg' }
}

/** Windows：优先用预热好的常驻代理，接不上再退回一次性脚本。 */
async function captureWindows(dir) {
  const outPath = join(dir, 'shot.jpg')
  const viaAgent = await captureWindowsViaAgent(outPath)
  if (viaAgent !== null) return viaAgent
  return captureWindowsOneShot(outPath)
}

/**
 * 提前把代理热起来。
 *
 * 页面挂载时会 POST /hotkey 同步全局热键，那一刻起用户就随时可能按快捷键，
 * 所以在那时花一次 ~1.9 秒把 PowerShell 起好、把 WinForms 与截图链路预热完，
 * 之后每次截图只花 ~0.15 秒出选框。
 */
let agentWarmAt = 0
let agentWarmFailures = 0

function warmCaptureAgent() {
  if (process.platform !== 'win32') return
  if (captureAgent !== null) return
  const nowMs = Date.now()
  if (nowMs - agentWarmAt < 3000) return
  agentWarmAt = nowMs
  if (agentWarmFailures >= 3) return
  const agent = startCaptureAgent()
  if (agent.dead !== true) captureAgent = agent
  agent.ready
    .then(() => {
      agentWarmFailures = 0
      if (captureAgent === agent) scheduleAgentIdleStop(agent)
    })
    .catch(() => {
      agentWarmFailures += 1
    })
}

/** 老路径：每次截图都起一个 PowerShell（冷启动 ~1.1-1.6 秒）。仅作兜底。 */
async function captureWindowsOneShot(outPath) {
  const result = await run(
    POWERSHELL_COMMAND,
    [
      ...POWERSHELL_FLAGS,
      '-STA',
      '-File',
      WINDOWS_CAPTURE_SCRIPT,
      '-Out',
      outPath,
      '-MaxEdge',
      String(TARGET_MAX_EDGE),
      '-Quality',
      JPEG_QUALITY
    ],
    10 * 60 * 1000
  )

  if (await exists(outPath)) return { path: outPath, mime: 'image/jpeg', extension: 'jpg' }
  if (result.code === 3) return { ok: false, code: 'cancelled', error: '已取消截图。' }
  if (result.spawnError) {
    return {
      ok: false,
      code: 'failed',
      error: '截图失败：没能启动 PowerShell。请确认系统自带的 Windows PowerShell 可以运行。'
    }
  }
  if (result.timedOut) return { ok: false, code: 'failed', error: '截图超时，请重试。' }
  const detail = result.stderr.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return {
    ok: false,
    code: 'failed',
    error: detail === '' ? '截图失败，请重试。' : `截图失败：${detail.slice(0, 200)}`
  }
}

async function captureOnce() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return {
      ok: false,
      code: 'unsupported-platform',
      error: '截图工具目前支持 macOS 与 Windows。'
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
  const rawPath = join(dir, 'shot.png')
  try {
    const picked =
      process.platform === 'darwin' ? await captureDarwin(dir, rawPath) : await captureWindows(dir)
    if (picked.ok === false) return picked

    let file = picked
    let bytes = await readFile(file.path)
    let dataUrl = `data:${file.mime};base64,${bytes.toString('base64')}`
    if (dataUrl.length > MAX_DATA_URL_BYTES && process.platform === 'darwin') {
      file = await toJpeg(rawPath, dir, FALLBACK_MAX_EDGE)
      bytes = await readFile(file.path)
      dataUrl = `data:${file.mime};base64,${bytes.toString('base64')}`
    }
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      return { ok: false, code: 'too-large', error: '截图太大了，换个区域再试一次。' }
    }

    return { ok: true, dataUrl, mime: file.mime, name: fileNameOf(file.extension) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 全局热键被按下：和按钮同一条截图链路，但结果不直接回给某个请求，
 * 而是放进 pending 队列，等页面轮询取走。
 */
async function handleGlobalTrigger() {
  lastTriggerAt = Date.now()
  try {
    const result = await enqueue(captureOnce)
    if (result !== null && typeof result === 'object' && result.ok === true) {
      pendingCaptures.push({
        id: ++pendingSequence,
        dataUrl: result.dataUrl,
        mime: result.mime,
        name: result.name,
        at: Date.now()
      })
      while (pendingCaptures.length > PENDING_LIMIT) pendingCaptures.shift()
    }
  } catch (error) {
    logger?.warn?.(`dsh-screenshot: 全局热键截图失败：${messageOf(error)}`)
  }
}

function recordHelperLine(line) {
  helperLog.push(line)
  while (helperLog.length > HELPER_LOG_LIMIT) helperLog.shift()
}

function stopHelper() {
  if (helperChild !== null) {
    const child = helperChild
    helperChild = null
    helperKey = ''
    helperKind = ''
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }
}

/** 按平台把抽象键位翻译成辅助程序的启动参数；undefined = 平台不支持，null = 键位不支持。 */
function helperLaunchOf(spec) {
  if (process.platform === 'darwin') {
    const hotkey = darwinHotkeyOf(spec)
    if (hotkey === null) return null
    return {
      kind: 'swift',
      command: HELPER_PATH,
      args: ['--key', String(hotkey.keycode), '--mods', String(hotkey.mods)]
    }
  }
  if (process.platform === 'win32') {
    const hotkey = windowsHotkeyOf(spec)
    if (hotkey === null) return null
    return {
      kind: 'powershell',
      command: POWERSHELL_COMMAND,
      args: [
        ...POWERSHELL_FLAGS,
        '-STA',
        '-File',
        WINDOWS_HOTKEY_SCRIPT,
        '-Vk',
        String(hotkey.vk),
        '-Mods',
        String(hotkey.mods),
        '-AppName',
        APP_PROCESS_NAME,
        '-ParentPid',
        String(process.ppid ?? 0)
      ]
    }
  }
  return undefined
}

/**
 * 按页面同步过来的键位启动辅助程序；同一份键位重复上报不会重启进程。
 * 辅助程序在 DSH 前台时会自己注销热键，把按键让给应用内快捷键。
 */
function spawnHelper(spec) {
  const launch = helperLaunchOf(spec)
  if (launch === undefined) return { ok: false, code: 'unsupported-platform' }
  if (launch === null) return { ok: false, code: 'unsupported-key' }

  const key = `${launch.kind}:${JSON.stringify(spec)}`
  if (helperChild !== null && helperKey === key) {
    return { ok: true, active: true }
  }
  stopHelper()

  let child
  try {
    child = spawn(launch.command, launch.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    logger?.warn?.(`dsh-screenshot: 全局热键辅助程序启动失败：${messageOf(error)}`)
    return { ok: false, code: 'helper-spawn-failed' }
  }

  helperChild = child
  helperKey = key
  helperKind = launch.kind

  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      recordHelperLine(line)
      if (line === 'TRIGGER') {
        void handleGlobalTrigger()
      } else if (line.startsWith('ERROR')) {
        // 比如组合键已被系统或其它 App 占用：退回「应用内快捷键仍可用」。
        logger?.warn?.(`dsh-screenshot: 全局热键注册失败（${line}），该组合可能已被系统占用`)
      } else if (line.startsWith('READY')) {
        logger?.debug?.(`dsh-screenshot: 全局热键辅助程序就绪（${line}）`)
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    logger?.debug?.(`dsh-screenshot: hotkey stderr: ${String(chunk).trim()}`)
  })
  child.on('error', (error) => {
    logger?.warn?.(`dsh-screenshot: 全局热键辅助程序异常：${messageOf(error)}`)
  })
  child.on('exit', () => {
    if (helperChild === child) {
      helperChild = null
      helperKey = ''
      helperKind = ''
    }
  })

  return { ok: true, active: true }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function hasCaptureHeader(req) {
  return req.headers[REQUIRED_HEADER] === REQUIRED_HEADER_VALUE
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  if (pathname === CAPTURE_PATH) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'dsh-screenshot: POST required' })
      return
    }
    if (!hasCaptureHeader(req)) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'dsh-screenshot: missing capture header' })
      return
    }
    warmCaptureAgent()
    try {
      const result = await enqueue(captureOnce)
      sendJson(res, 200, result)
    } catch (error) {
      logger?.warn?.(`dsh-screenshot: capture failed: ${messageOf(error)}`)
      sendJson(res, 500, { ok: false, code: 'internal', error: 'dsh-screenshot: 截图失败，请重试。' })
    }
    return
  }

  if (pathname === PENDING_PATH && req.method === 'GET') {
    sendJson(res, 200, { ok: true, items: pendingCaptures })
    return
  }

  if (pathname === TAKE_PATH && req.method === 'POST') {
    if (!hasCaptureHeader(req)) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'dsh-screenshot: missing capture header' })
      return
    }
    const body = await readJsonBody(req)
    const id = body !== null && typeof body === 'object' ? body.id : undefined
    const index = pendingCaptures.findIndex((item) => item.id === id)
    if (index >= 0) pendingCaptures.splice(index, 1)
    sendJson(res, 200, { ok: true, removed: index >= 0 })
    return
  }

  if (pathname === HOTKEY_PATH && req.method === 'POST') {
    if (!hasCaptureHeader(req)) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'dsh-screenshot: missing capture header' })
      return
    }
    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object') {
      sendJson(res, 400, { ok: false, code: 'bad-request', error: 'dsh-screenshot: JSON body required' })
      return
    }
    if (body.enabled === false) {
      stopHelper()
      sendJson(res, 200, { ok: true, active: false })
      return
    }
    const spec = hotkeySpecOf(body)
    if (spec === null) {
      sendJson(res, 400, { ok: false, code: 'bad-request', error: 'dsh-screenshot: invalid hotkey binding' })
      return
    }
    warmCaptureAgent()
    const result = spawnHelper(spec)
    sendJson(res, 200, {
      ok: result.ok,
      active: helperChild !== null,
      code: result.code,
      helperKind: helperKind === '' ? null : helperKind
    })
    return
  }

  if (pathname === STATUS_PATH && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      platform: process.platform,
      supported: process.platform === 'darwin' || process.platform === 'win32',
      active: helperChild !== null,
      lastTriggerAt,
      pending: pendingCaptures.length,
      helperKey,
      helperKind: helperKind === '' ? null : helperKind,
      helperLog: [...helperLog],
      // 常驻截图代理的状态：diagnostics 用，页面不依赖它。
      agent:
        captureAgent === null
          ? null
          : {
              pid: captureAgent.child?.pid ?? null,
              warm: captureAgent.readyAt > 0,
              inflight: captureAgent.waiting.size
            }
    })
    return
  }

  sendJson(res, 404, { ok: false, code: 'not-found', error: 'dsh-screenshot: not found' })
}

export function apply(ctx) {
  logger = ctx.logger ?? console

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: handleRequest
      }),
    'dsh-screenshot: capture route'
  )

  ctx.effect(() => () => stopHelper(), 'dsh-screenshot: global hotkey helper')
  ctx.effect(() => () => stopCaptureAgent(), 'dsh-screenshot: windows capture agent')
}
