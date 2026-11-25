// 客户端 smoke test：在 Node 里用最小假的 DSH 运行时加载 lib/client.js，
// 验证命令注册、键位同步、槽位挂载和「全局截图 → 草稿附件」链路。
// 不需要 DSH 本体，可在 CI 跑：node test/client-smoke.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const calls = { fetch: [], drafts: [], addFiles: [], focus: 0, slots: [] }
const focusHandlers = []
let pendingItems = []

const fakeFetch = async (url, init = {}) => {
  const path = String(url)
  calls.fetch.push({ url: path, method: init.method ?? 'GET', body: init.body ?? null })
  if (path.includes('/hotkey')) return { ok: true, status: 200, json: async () => ({ ok: true, active: true }) }
  if (path.includes('/pending')) return { ok: true, status: 200, json: async () => ({ ok: true, items: pendingItems }) }
  if (path.includes('/take')) {
    const id = JSON.parse(init.body).id
    pendingItems = pendingItems.filter((item) => item.id !== id)
    return { ok: true, status: 200, json: async () => ({ ok: true, removed: true }) }
  }
  if (path.includes('/capture')) return { ok: true, status: 200, json: async () => ({ ok: true, dataUrl: PIXEL, mime: 'image/png', name: 's.png' }) }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}
globalThis.fetch = fakeFetch

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn
}

const document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', style: {} }),
  head: { appendChild: () => {} },
  documentElement: { dataset: {} },
  addEventListener: () => {},
  removeEventListener: () => {}
}

const window = {
  __ModuleLoader__: {
    load: (definition) => {
      const require = (name) => {
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: (props) => React.createElement('div', props, props.children) }
        throw new Error('unexpected require: ' + name)
      }
      mod = definition.factory(require)
    }
  },
  setInterval: () => 1,
  clearInterval: () => {},
  addEventListener: (name, handler) => {
    if (name === 'focus') focusHandlers.push(handler)
  },
  removeEventListener: () => {},
  setTimeout,
  clearTimeout
}

globalThis.window = window
globalThis.document = document
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 Electron/33', mediaDevices: undefined },
  configurable: true
})

let mod
await import('data:text/javascript,' + encodeURIComponent(src))

const cleanups = []
const shell = {
  snapshot: { phase: 'idle' },
  addFiles: (before, ids) => {
    calls.addFiles.push(ids)
    return true
  },
  focus: () => {
    calls.focus += 1
  },
  notify: () => {}
}
const conversation = {
  input: { shell: () => shell },
  createDrafts: (sessionId, files) => {
    calls.drafts.push({ sessionId, count: files.length })
    return [{ id: 'd1' }]
  },
  releaseDraftAttachments: () => {}
}
const registered = []
const ctx = {
  effect: (fn) => {
    cleanups.push(fn())
  },
  get: (name) => (name === 'conversation' ? conversation : undefined),
  conversation,
  locale: { register: () => () => {}, bind: () => (key) => key },
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { retainedBy: { mainView: 1 } } } }) } },
  slots: {
    inject: (slotName, register) => register(),
    register: (options) => {
      calls.slots.push(options)
      return () => {}
    }
  },
  shortcuts: {
    catalog: {
      getSnapshot: () => [{ id: 'dsh-screenshot.capture', binding: { code: 'KeyS', modifiers: ['alt', 'meta'] }, keys: ['⌥', '⌘', 'S'], aria: 'Alt+Meta+S' }],
      subscribe: () => () => {}
    },
    register: (command) => {
      registered.push(command)
      return () => {}
    }
  }
}

mod.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 20))

const command = registered.find((entry) => entry?.id === 'dsh-screenshot.capture')
assert.ok(command, '快捷键命令 dsh-screenshot.capture 应已注册')
assert.deepEqual(command.regions, ['page', 'editable'])
assert.equal(command.defaults['desktop:macos'].code, 'KeyS')
assert.deepEqual(command.defaults['desktop:macos'].modifiers, ['primary', 'alt'])
assert.equal(command.defaults['web:linux'], undefined)

const hotkeyCall = calls.fetch.find((entry) => entry.url.includes('/hotkey'))
assert.ok(hotkeyCall, '应把当前键位同步给宿主的全局热键')
assert.deepEqual(JSON.parse(hotkeyCall.body), { code: 'KeyS', modifiers: ['alt', 'meta'] })

const slots = calls.slots.map((entry) => entry.id + '#' + entry.name)
assert.ok(slots.includes('dsh-screenshot#conversation.input.left'), '应挂到 conversation.input.left 槽位')

pendingItems = [{ id: 7, dataUrl: PIXEL, mime: 'image/png', name: 's.png' }]
focusHandlers[0]()
await new Promise((resolve) => setTimeout(resolve, 40))

assert.deepEqual(calls.drafts, [{ sessionId: 's1', count: 1 }])
assert.deepEqual(calls.addFiles, [['d1']])
assert.ok(calls.fetch.some((entry) => entry.url.includes('/take')), '取走后应确认 take')
assert.equal(pendingItems.length, 0)

for (const cleanup of cleanups.slice().reverse()) if (typeof cleanup === 'function') cleanup()
console.log('client smoke OK')
