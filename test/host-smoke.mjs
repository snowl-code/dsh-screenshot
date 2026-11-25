// 宿主 smoke test（仅 macOS）：起一个假的 DSH 宿主 ctx，验证路由、
// 参数校验、辅助程序拉起/停止、以及全局热键截图队列。
// 运行：node test/host-smoke.mjs     （需要先 ./helper/build.sh 生成 bin/dsh-hotkey）
import { EventEmitter } from 'node:events'
import { execSync } from 'node:child_process'
import assert from 'node:assert/strict'

if (process.platform !== 'darwin') {
  console.log('host smoke skipped: macOS only')
  process.exit(0)
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let handler = null
const cleanups = []
const logs = []
const ctx = {
  logger: {
    info: (msg) => logs.push('info: ' + msg),
    warn: (msg) => logs.push('warn: ' + msg),
    debug: (msg) => logs.push('debug: ' + msg)
  },
  effect: (fn) => cleanups.push(fn()),
  webServer: {
    register: (options) => {
      handler = options.handler
      return () => {}
    }
  }
}

function makeReq({ method = 'GET', url = '/', headers = {}, body = null }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
    },
    end(chunk) {
      this.body += chunk ?? ''
    }
  }
}

async function call(options) {
  const res = makeRes()
  await handler(makeReq(options), res)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

mod.apply(ctx)
assert.ok(handler, '宿主应注册 webServer 路由处理器')

const headers = { 'x-dsh-screenshot': '1', 'content-type': 'application/json' }

const statusBefore = await call({ method: 'GET', url: '/dsh-screenshot-capture/status' })
assert.equal(statusBefore.payload.ok, true)
assert.equal(statusBefore.payload.active, false)

// 旧版页面发来的 macOS 键码 + Carbon 掩码仍要能识别（0.2.x 页面在重启前还会这么发）
const enable = await call({ method: 'POST', url: '/dsh-screenshot-capture/hotkey', headers, body: JSON.stringify({ keycode: 1, mods: 2304 }) })
assert.equal(enable.payload.active, true)
assert.equal(enable.payload.helperKind, 'swift')
await new Promise((resolve) => setTimeout(resolve, 400))

const statusOn = await call({ method: 'GET', url: '/dsh-screenshot-capture/status' })
assert.equal(statusOn.payload.active, true)
assert.equal(statusOn.payload.helperKey, 'swift:{"code":"KeyS","modifiers":["primary","alt"]}')
assert.ok(Array.isArray(statusOn.payload.helperLog) && statusOn.payload.helperLog.length > 0, '应记录辅助程序日志')

const pending = await call({ method: 'GET', url: '/dsh-screenshot-capture/pending' })
assert.deepEqual(pending.payload.items, [])

const bad = await call({ method: 'POST', url: '/dsh-screenshot-capture/hotkey', headers, body: JSON.stringify({ keycode: 'x' }) })
assert.equal(bad.status, 400)

// 抽象形态（新版页面）也接受；macOS 映射不到的键回 400
const abstract = await call({ method: 'POST', url: '/dsh-screenshot-capture/hotkey', headers, body: JSON.stringify({ code: 'KeyS', modifiers: ['primary', 'alt'] }) })
assert.equal(abstract.payload.active, true)
const unmapped = await call({ method: 'POST', url: '/dsh-screenshot-capture/hotkey', headers, body: JSON.stringify({ code: 'F13', modifiers: ['primary'] }) })
assert.equal(unmapped.payload.ok, false)
assert.equal(unmapped.payload.code, 'unsupported-key')

const disable = await call({ method: 'POST', url: '/dsh-screenshot-capture/hotkey', headers, body: JSON.stringify({ enabled: false }) })
assert.equal(disable.payload.active, false)
await new Promise((resolve) => setTimeout(resolve, 300))
const running = execSync("pgrep -fl 'dsh-hotkey' || true").toString().trim()
// 过滤掉 DSH 安装目录（.generations/live/…）里正在为桌面端服务的辅助程序，
// 只关心本次测试从仓库目录拉起的那个。
const ours = running.split('\n').filter((line) => line.includes('/bin/dsh-hotkey') && !line.includes('.generations/'))
assert.deepEqual(ours, [], '禁用后应停掉测试拉起的辅助程序')

const forbidden = await call({ method: 'POST', url: '/dsh-screenshot-capture/take', headers: {}, body: '{}' })
assert.equal(forbidden.status, 403)

for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') cleanup()
console.log('host smoke OK')
