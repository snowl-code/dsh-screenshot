// 键位映射 smoke test：页面只上报抽象键位，宿主按平台翻译。
// 这里只测纯函数，不启动任何进程：node test/keycodes-smoke.mjs
import assert from 'node:assert/strict'
import { darwinHotkeyOf, hotkeySpecOf, windowsHotkeyOf } from '../lib/index.js'

// 页面发来的抽象形态（新版）
assert.deepEqual(hotkeySpecOf({ code: 'KeyS', modifiers: ['primary', 'alt'] }), {
  code: 'KeyS',
  modifiers: ['primary', 'alt']
})
assert.deepEqual(hotkeySpecOf({ code: 'KeyS', modifiers: ['alt', 'primary', 'alt'] }), {
  code: 'KeyS',
  modifiers: ['alt', 'primary']
})
assert.equal(hotkeySpecOf({ code: 'KeyS', modifiers: [] }), null)
assert.equal(hotkeySpecOf({ code: 'KeyS' }), null)

// 旧版页面发来的 macOS 键码 + Carbon 掩码仍能识别
assert.deepEqual(hotkeySpecOf({ keycode: 1, mods: 2304 }), {
  code: 'KeyS',
  modifiers: ['primary', 'alt']
})
assert.equal(hotkeySpecOf({ keycode: 'x' }), null)

// macOS：Carbon kVK_* + cmdKey/optionKey
assert.deepEqual(darwinHotkeyOf({ code: 'KeyS', modifiers: ['primary', 'alt'] }), {
  keycode: 1,
  mods: 0x0100 | 0x0800
})
assert.deepEqual(darwinHotkeyOf({ code: 'KeyO', modifiers: ['primary', 'shift'] }), {
  keycode: 31,
  mods: 0x0100 | 0x0200
})
assert.equal(darwinHotkeyOf({ code: 'F13', modifiers: ['primary'] }), null)

// Windows：VK_* + RegisterHotKey 的 MOD_*；primary 落到 Control
assert.deepEqual(windowsHotkeyOf({ code: 'KeyS', modifiers: ['primary', 'alt'] }), {
  vk: 0x53,
  mods: 0x0001 | 0x0002
})
assert.deepEqual(windowsHotkeyOf({ code: 'KeyS', modifiers: ['primary', 'shift'] }), {
  vk: 0x53,
  mods: 0x0002 | 0x0004
})
assert.deepEqual(windowsHotkeyOf({ code: 'KeyL', modifiers: ['meta', 'shift'] }), {
  vk: 0x4c,
  mods: 0x0008 | 0x0004
})
assert.deepEqual(windowsHotkeyOf({ code: 'F12', modifiers: ['control'] }), {
  vk: 0x7b,
  mods: 0x0002
})
assert.deepEqual(windowsHotkeyOf({ code: 'Slash', modifiers: ['primary'] }), {
  vk: 0xbf,
  mods: 0x0002
})
assert.equal(windowsHotkeyOf({ code: 'MediaPlayPause', modifiers: ['primary'] }), null)
assert.equal(windowsHotkeyOf({ code: 'KeyS', modifiers: [] }), null)

console.log('keycodes smoke OK')
