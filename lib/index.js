/**
 * dsh-screenshot —— 宿主半侧
 *
 * 职责：
 *   1) 给页面一个「把当前屏幕截下来」的本地路由（桌面端 Electron 没有 display-media
 *      handler，所以改调 macOS 自带的 screencapture）；
 *   2) 支撑「系统级全局热键」：页面把快捷键目录里的当前键位 POST 过来，宿主据此
 *      启动随包发布的 Swift 辅助程序（bin/dsh-hotkey）。辅助程序在 DSH 失焦时向
 *      系统注册热键，按下后向 stdout 打一行 TRIGGER；宿主收到后走同一套截图流程，
 *      把结果放进 pending 队列，页面轮询取走并塞进当前草稿。
 *
 * 路由（都挂在 /dsh-screenshot-capture 前缀下）：
 *   POST /capture   -> { ok, dataUrl, mime, name } | { ok:false, code, error }
 *   GET  /pending   -> { ok, items: [{ id, dataUrl, mime, name, at }] }
 *   POST /take      -> { ok, removed }          页面把已入草稿的截图确认掉
 *   POST /hotkey    -> { ok, active }           { keycode, mods } 或 { enabled: false }
 *   GET  /status    -> { ok, platform, active, lastTriggerAt, pending }
 *
 * 截图先落在临时目录，再用 sips 压到长边 1800px 的 JPEG，随后立刻删掉临时目录，
 * 只把 base64 交给页面。页面拿到后自己造 File 丢进草稿附件。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
let lastTriggerAt = 0
let logger = console

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
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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

async function captureOnce() {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      code: 'unsupported-platform',
      error: '截图工具目前只支持 macOS（依赖系统自带的 screencapture）。'
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
  const rawPath = join(dir, 'shot.png')
  try {
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

    let picked = await toJpeg(rawPath, dir, TARGET_MAX_EDGE)
    let bytes = await readFile(picked.path)
    let dataUrl = `data:${picked.mime};base64,${bytes.toString('base64')}`
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      picked = await toJpeg(rawPath, dir, FALLBACK_MAX_EDGE)
      bytes = await readFile(picked.path)
      dataUrl = `data:${picked.mime};base64,${bytes.toString('base64')}`
    }
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      return { ok: false, code: 'too-large', error: '截图太大了，换个区域再试一次。' }
    }

    return { ok: true, dataUrl, mime: picked.mime, name: fileNameOf(picked.extension) }
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
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }
}

/**
 * 按页面同步过来的键位启动辅助程序；同一份键位重复上报不会重启进程。
 * 辅助程序在 DSH 前台时会自己注销热键，把按键让给应用内快捷键。
 */
function spawnHelper(config) {
  if (process.platform !== 'darwin') {
    return { ok: false, code: 'unsupported-platform' }
  }
  const key = `${config.keycode}:${config.mods}`
  if (helperChild !== null && helperKey === key) {
    return { ok: true, active: true }
  }
  stopHelper()

  let child
  try {
    child = spawn(HELPER_PATH, ['--key', String(config.keycode), '--mods', String(config.mods)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    logger?.warn?.(`dsh-screenshot: 全局热键辅助程序启动失败：${messageOf(error)}`)
    return { ok: false, code: 'helper-spawn-failed' }
  }

  helperChild = child
  helperKey = key

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
    const keycode = body.keycode
    const mods = body.mods
    if (
      !Number.isInteger(keycode) ||
      keycode < 0 ||
      keycode > 127 ||
      !Number.isInteger(mods) ||
      mods < 0 ||
      mods > 0xffff
    ) {
      sendJson(res, 400, { ok: false, code: 'bad-request', error: 'dsh-screenshot: invalid keycode/mods' })
      return
    }
    const result = spawnHelper({ keycode, mods })
    sendJson(res, 200, { ok: result.ok, active: helperChild !== null, code: result.code })
    return
  }

  if (pathname === STATUS_PATH && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      platform: process.platform,
      active: helperChild !== null,
      lastTriggerAt,
      pending: pendingCaptures.length,
      helperKey,
      helperLog: [...helperLog]
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
}
