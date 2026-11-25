/**
 * dsh-screenshot —— 浏览器半侧
 *
 * 在对话框左下角的工具条里加一个截图按钮：
 *   1) 浏览器（Chrome/Edge/Safari…）：走 getDisplayMedia，系统自带的共享选择器；
 *   2) DSH Desktop（Electron）：窗口没有 display-media handler，改由宿主路由调
 *      macOS 的 screencapture 框选，截完再把 base64 交回来。
 * 拿到图后走 conversation.createDrafts + shell.addFiles 这条官方入草稿路径，
 * 和粘贴图片完全同一条链路，所以缩略图、上传、发送都一样。
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-screenshot'
    const ROUTE = '/dsh-screenshot-capture/capture'
    const PENDING_ROUTE = '/dsh-screenshot-capture/pending'
    const TAKE_ROUTE = '/dsh-screenshot-capture/take'
    const HOTKEY_ROUTE = '/dsh-screenshot-capture/hotkey'
    /** 命令 ID 同时出现在快捷键弹窗、按钮 tooltip 和 aria-keyshortcuts 上。 */
    const COMMAND_ID = 'dsh-screenshot.capture'
    /** 全局热键截图多久轮询一次；窗口重新获得焦点时也会立刻补一次。 */
    const POLL_INTERVAL_MS = 1500

    /** apply() 时保存的客户端 ctx，供按钮点击时取 conversation 服务。 */
    let clientCtx = null
    /** 最近一次渲染出输入框的会话：全局热键截图落到「当前对话框」。 */
    let lastSessionId = undefined
    /** 已处理过的全局截图 id，避免确认请求失败时重复入草稿。 */
    const handledCaptureIds = new Set()
    let pollInFlight = false
    /** 上一次同步给宿主的全局键位，避免目录每次变化都重启辅助程序。 */
    let lastHotkeySignature = ''

    const zh = {
      'button.label': '截图提问',
      'button.busy': '正在截图…',
      'shortcut.label': '截图提问',
      'shortcut.blocked': '现在没有可以接收截图的对话框',
      'error.cancelled': '已取消截图',
      'error.permission': '截图失败：请在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选 DSH Desktop，然后重启应用',
      'error.noSession': '当前对话框还不能添加附件',
      'error.noComposer': '输入框还没准备好，请稍后再试',
      'error.locked': '输入框正在发送消息，稍后再截图',
      'error.unsupported': '这个图片格式不能作为附件',
      'error.failed': '截图失败，请重试',
      'error.unsupportedPlatform': '截图工具目前只支持 macOS'
    }

    const en = {
      'button.label': 'Screenshot',
      'button.busy': 'Capturing…',
      'shortcut.label': 'Screenshot',
      'shortcut.blocked': 'No conversation can accept a screenshot right now',
      'error.cancelled': 'Screenshot cancelled',
      'error.permission': 'Screenshot failed: enable Screen Recording for DSH Desktop in System Settings → Privacy & Security, then restart the app',
      'error.noSession': 'This conversation cannot accept attachments yet',
      'error.noComposer': 'The composer is not ready yet, try again in a moment',
      'error.locked': 'The composer is busy sending, try again shortly',
      'error.unsupported': 'That image type cannot be attached',
      'error.failed': 'Screenshot failed, please try again',
      'error.unsupportedPlatform': 'Screenshot capture currently supports macOS only'
    }

    const STYLE_ID = 'dsh-screenshot-style'
    const CSS = `
      .dsh-screenshot-button {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px;
        background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
        cursor: pointer; transition: background-color 120ms ease, color 120ms ease;
      }
      .dsh-screenshot-button:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2, rgba(125, 125, 125, 0.14));
        color: var(--dsw-alias-label-primary, #111827);
      }
      .dsh-screenshot-button:disabled { opacity: .55; cursor: default; }
      .dsh-screenshot-button[data-busy="true"] svg { animation: dsh-screenshot-pulse 1s ease-in-out infinite; }
      @keyframes dsh-screenshot-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
      .dsh-screenshot-error {
        font-size: 11px; line-height: 1.3; color: #b42318; max-width: 240px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
    `

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head?.appendChild(style)
    }

    function base64ToBytes(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    function fileFromDataUrl(dataUrl, fallbackName) {
      const comma = dataUrl.indexOf(',')
      if (comma < 0) throw new Error('invalid data url')
      const header = dataUrl.slice(0, comma)
      const body = dataUrl.slice(comma + 1)
      const mimeMatch = /^data:([^;,]+)/.exec(header)
      const mime = mimeMatch === null ? 'image/png' : mimeMatch[1]
      const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      const name = fallbackName !== undefined && fallbackName.endsWith(`.${extension}`) ? fallbackName : `screenshot-${stamp}.${extension}`
      return new File([base64ToBytes(body)], name, { type: mime })
    }

    function isDesktopShell() {
      return /Electron\//i.test(navigator.userAgent ?? '')
    }

    const MODIFIER_NAMES = ['primary', 'alt', 'shift', 'control', 'meta']

    /**
     * 把快捷键目录里的当前键位归一成抽象形态上报给宿主：{ code, modifiers }。
     * 具体用哪套虚拟键码（Carbon / Windows VK）由宿主按平台翻译，页面不关心。
     * 双键和弦、没有修饰键的组合不做全局注册（返回 { enabled: false }），
     * 应用内快捷键仍然照常工作。
     */
    function globalHotkeyOf(row) {
      const binding = row !== null && typeof row === 'object' ? row.binding : null
      if (binding === null || typeof binding !== 'object') return { enabled: false }
      if (binding.secondCode !== undefined) return { enabled: false }
      if (typeof binding.code !== 'string' || binding.code === '') return { enabled: false }
      const modifiers = Array.isArray(binding.modifiers)
        ? binding.modifiers.filter((modifier) => MODIFIER_NAMES.includes(modifier))
        : []
      if (modifiers.length === 0) return { enabled: false }
      return { code: binding.code, modifiers }
    }

    /** 把当前键位同步给宿主；宿主只在键位变化时重启辅助程序。 */
    function syncGlobalHotkey(row) {
      if (!isDesktopShell()) return
      const signature = JSON.stringify(globalHotkeyOf(row))
      if (signature === lastHotkeySignature) return
      lastHotkeySignature = signature
      const reset = () => {
        lastHotkeySignature = ''
      }
      fetch(HOTKEY_ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-dsh-screenshot': '1' },
        body: signature
      })
        .then((response) => {
          if (!response.ok) reset()
        })
        .catch(reset)
    }

    /** 确认宿主队列里的某张全局截图已被取走。 */
    async function takeGlobalCapture(id) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(TAKE_ROUTE, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', 'x-dsh-screenshot': '1' },
            body: JSON.stringify({ id })
          })
          if (response.ok) return
        } catch {
          /* 重试一次 */
        }
      }
    }

    /**
     * 取走宿主在 DSH 失焦时截到的图，塞进当前对话框的草稿附件。
     * 没有可用会话、或输入框正在发送时把图留在宿主队列里，下一轮再试。
     */
    async function pollGlobalCaptures() {
      if (!isDesktopShell() || pollInFlight) return
      pollInFlight = true
      try {
        const response = await fetch(PENDING_ROUTE, { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json().catch(() => null)
        const items = payload !== null && typeof payload === 'object' && Array.isArray(payload.items) ? payload.items : []
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue
          const id = item.id
          if (handledCaptureIds.has(id)) {
            await takeGlobalCapture(id)
            continue
          }
          if (typeof item.dataUrl !== 'string') continue
          const sessionId = currentSessionId()
          if (sessionId === undefined) return
          let file
          try {
            file = fileFromDataUrl(item.dataUrl, typeof item.name === 'string' ? item.name : undefined)
          } catch {
            await takeGlobalCapture(id)
            continue
          }
          try {
            attachToDraft(sessionId, file)
          } catch {
            return
          }
          handledCaptureIds.add(id)
          if (handledCaptureIds.size > 32) handledCaptureIds.clear()
          await takeGlobalCapture(id)
        }
      } catch {
        /* 宿主路由暂时不可用：下一轮再试 */
      } finally {
        pollInFlight = false
      }
    }

    async function captureInBrowser() {
      const media = navigator.mediaDevices
      if (media === undefined || typeof media.getDisplayMedia !== 'function') {
        throw Object.assign(new Error('getDisplayMedia unavailable'), { code: 'unsupported-platform' })
      }
      const stream = await media.getDisplayMedia({ video: true, audio: false })
      try {
        const track = stream.getVideoTracks()[0]
        const video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        await video.play()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const width = video.videoWidth
        const height = video.videoHeight
        if (!width || !height) throw Object.assign(new Error('empty frame'), { code: 'failed' })
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (context === null) throw Object.assign(new Error('no 2d context'), { code: 'failed' })
        context.drawImage(video, 0, 0, width, height)
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((value) => (value === null ? reject(new Error('encode failed')) : resolve(value)), 'image/png')
        })
        const now = new Date()
        const pad = (value) => String(value).padStart(2, '0')
        const name = `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
        return new File([blob], name, { type: 'image/png' })
      } finally {
        for (const item of stream.getTracks()) item.stop()
      }
    }

    async function captureOnHost() {
      const response = await fetch(ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-dsh-screenshot': '1' },
        body: '{}'
      })
      const payload = await response.json().catch(() => null)
      if (payload === null || typeof payload !== 'object') {
        throw Object.assign(new Error('host route returned no payload'), { code: 'failed' })
      }
      if (payload.ok !== true) {
        throw Object.assign(new Error(String(payload.error ?? 'capture failed')), {
          code: typeof payload.code === 'string' ? payload.code : 'failed'
        })
      }
      return fileFromDataUrl(String(payload.dataUrl), typeof payload.name === 'string' ? payload.name : undefined)
    }

    async function captureFile() {
      if (isDesktopShell()) return captureOnHost()
      if (navigator.mediaDevices !== undefined && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
        try {
          return await captureInBrowser()
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'NotAllowedError') {
            throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
          }
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'failed' })
        }
      }
      return captureOnHost()
    }

    function attachToDraft(sessionId, file) {
      const conversation = clientCtx === null ? undefined : clientCtx.get('conversation')
      if (conversation === undefined || conversation === null) {
        throw Object.assign(new Error('conversation service unavailable'), { code: 'noComposer' })
      }
      let shell
      try {
        shell = conversation.input.shell(sessionId)
      } catch (error) {
        throw Object.assign(new Error('composer shell unavailable'), { code: 'noComposer' })
      }
      const phase = shell?.snapshot?.phase
      if (composerFrozen(phase)) {
        throw Object.assign(new Error('composer locked'), { code: 'locked' })
      }
      const drafts = conversation.createDrafts(sessionId, [file], true)
      const accepted = shell.addFiles([], drafts.map((draft) => draft.id))
      if (accepted !== true) {
        conversation.releaseDraftAttachments(drafts)
        throw Object.assign(new Error('draft rejected'), { code: 'locked' })
      }
      return drafts
    }

    function errorKeyOf(error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'cancelled') return 'error.cancelled'
      if (code === 'permission') return 'error.permission'
      if (code === 'unsupported-platform') return 'error.unsupportedPlatform'
      if (code === 'noComposer') return 'error.noComposer'
      if (code === 'locked') return 'error.locked'
      return 'error.failed'
    }

    /** 快捷键没有 sessionId 参数，按主视图保留的会话定位「当前对话框」。 */
    function findActiveSession(ctx) {
      try {
        const byId = ctx.sessions.list.getSnapshot().byId ?? {}
        for (const [sessionId, row] of Object.entries(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return sessionId
        }
      } catch {
        /* 会话服务还没准备好时按没有对话框处理 */
      }
      return undefined
    }

    /** 全局截图落点：优先上次渲染过输入框、且会话仍然存在的那个对话框。 */
    function currentSessionId() {
      if (typeof lastSessionId === 'string') {
        try {
          const byId = clientCtx?.sessions?.list?.getSnapshot()?.byId ?? {}
          if (byId[lastSessionId] !== undefined) return lastSessionId
        } catch {
          /* 落回按主视图查找 */
        }
      }
      return findActiveSession(clientCtx)
    }

    function composerFrozen(phase) {
      return phase === 'adjudicating' || phase === 'submitting' || phase === 'sending'
    }

    /**
     * 快捷键触发的截图：没有按钮实例可以展示行内错误，所以走 composer 的
     * notice 通道（banner/inline）提示失败；取消不提示。
     */
    async function shortcutCapture(sessionId, shell, t) {
      try {
        const file = await captureFile()
        attachToDraft(sessionId, file)
        shell?.focus?.()
      } catch (error) {
        const key = errorKeyOf(error)
        if (key === 'error.cancelled') return
        try {
          shell?.notify?.('error', t(key))
        } catch {
          /* composer 已经不存在时保持静默 */
        }
      }
    }

    function icon() {
      return React.createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
        React.createElement('path', { d: 'M2 5.6V3.9A1.9 1.9 0 0 1 3.9 2h1.7' }),
        React.createElement('path', { d: 'M10.4 2h1.7A1.9 1.9 0 0 1 14 3.9v1.7' }),
        React.createElement('path', { d: 'M14 10.4v1.7A1.9 1.9 0 0 1 12.1 14h-1.7' }),
        React.createElement('path', { d: 'M5.6 14H3.9A1.9 1.9 0 0 1 2 12.1v-1.7' }),
        React.createElement('circle', { cx: 8, cy: 8, r: 2.5 })
      )
    }

    /** 未安装快捷键服务时的占位 hook，保证组件内 hook 调用顺序稳定。 */
    function noShortcutRows() {
      return undefined
    }

    function shortcutRowOf(rows) {
      const list = Array.isArray(rows) ? rows : []
      return list.find((row) => row.id === COMMAND_ID)
    }

    function ScreenshotButton(props) {
      const sessionId = props.sessionId
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const useShortcuts = typeof props.useShortcuts === 'function' ? props.useShortcuts : noShortcutRows
      const shortcut = useShortcuts(shortcutRowOf)
      const shortcutKeys = Array.isArray(shortcut?.keys) && shortcut.keys.length > 0 ? shortcut.keys : undefined
      const [busy, setBusy] = React.useState(false)
      const [errorKey, setErrorKey] = React.useState('')
      const buttonRef = React.useRef(null)
      const timerRef = React.useRef(null)

      // 当前挂载的输入框就是「当前对话框」：全局热键截图优先落到这里。
      React.useEffect(() => {
        if (typeof sessionId === 'string' && sessionId !== '') lastSessionId = sessionId
      }, [sessionId])

      React.useEffect(() => {
        ensureStyle()
        return () => {
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        }
      }, [])

      const showError = React.useCallback((key) => {
        setErrorKey(key)
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          setErrorKey('')
        }, 6000)
      }, [])

      const capture = React.useCallback(
        async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (busy === true) return
          if (typeof sessionId !== 'string' || sessionId === '') {
            showError('error.noSession')
            return
          }
          setBusy(true)
          setErrorKey('')
          try {
            const file = await captureFile()
            attachToDraft(sessionId, file)
            const card = buttonRef.current?.closest('[data-composer-card]') ?? null
            const editable = card === null ? null : card.querySelector('[contenteditable="true"], textarea')
            editable?.focus?.()
          } catch (error) {
            showError(errorKeyOf(error))
          } finally {
            setBusy(false)
          }
        },
        [busy, sessionId, showError]
      )

      const label = busy === true ? t('button.busy') : t('button.label')
      const button = React.createElement(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'dsh-screenshot-button',
          'data-busy': busy === true ? 'true' : 'false',
          'aria-label': label,
          'aria-busy': busy === true,
          'aria-keyshortcuts': shortcut?.aria,
          disabled: busy === true,
          onMouseDown: (event) => event.preventDefault(),
          onClick: capture
        },
        icon()
      )

      const children = [button]
      if (errorKey !== '') {
        children.push(
          React.createElement(
            'span',
            { key: 'error', className: 'dsh-screenshot-error', role: 'alert', title: t(errorKey) },
            t(errorKey)
          )
        )
      }

      const tooltip = primitives === undefined ? null : primitives.Tooltip
      if (typeof tooltip === 'function') {
        // 官方用法要求 portal: true，否则浮层会以最近的定位祖先为基准（工具条不是定位元素，
        // 会落到视口左上角并一直可见）。这里沿用官方参数组合。
        return React.createElement(
          'div',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          React.createElement(tooltip, { label, side: 'top', delayMs: 400, portal: true, shortcutKeys }, button),
          ...children.slice(1)
        )
      }
      return React.createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, ...children)
    }

    const inject = ['slots', 'locale', 'conversation', 'sessions', 'shortcuts']

    /**
     * 截图命令的默认键位：桌面端与浏览器端统一用「主修饰键 + Alt + S」。
     * 不能用 ⌘/Ctrl+Shift+S —— dsh-pet 的 pet-chat.capture 已经占了这个键位，
     * 快捷键服务在注册期就会抛 `Conflicting shortcut defaults: …`，把整个插件启动打断。
     */
    const SHORTCUT_DEFAULTS = {
      'desktop:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyS', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyS', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyS', modifiers: ['primary', 'alt'] }
    }

    function apply(ctx) {
      clientCtx = ctx
      ensureStyle()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-screenshot: dictionaries')
      const t = ctx.locale.bind(NS)

      // 全局热键：把目录里本命令的当前键位同步给宿主，由宿主维护 Swift 辅助进程。
      ctx.effect(() => {
        if (!isDesktopShell()) return () => {}
        const catalog = ctx.shortcuts.catalog
        const refresh = () => {
          let row
          try {
            row = shortcutRowOf(catalog.getSnapshot())
          } catch {
            return
          }
          syncGlobalHotkey(row)
        }
        refresh()
        const unsubscribe = catalog.subscribe(refresh)
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, 'dsh-screenshot: global hotkey sync')

      // 全局热键的截图由宿主排队；页面（即使窗口失焦）轮询取走并塞进当前草稿。
      ctx.effect(() => {
        if (!isDesktopShell()) return () => {}
        const timer = window.setInterval(() => {
          void pollGlobalCaptures()
        }, POLL_INTERVAL_MS)
        const onFocus = () => {
          void pollGlobalCaptures()
        }
        window.addEventListener('focus', onFocus)
        void pollGlobalCaptures()
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, 'dsh-screenshot: global capture poller')

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-screenshot',
            order: 30,
            locale: NS,
            // 让按钮拿到快捷键目录：hooks.shortcuts -> prop.useShortcuts
            inject: () => ({ hooks: { shortcuts: ctx.shortcuts.catalog } })
          },
          ScreenshotButton
        )
      )
      // 命令登记进 DSH 自己的快捷键目录：设置 → 通用 → 快捷键 里即可改键，
      // 与 Mod+/ 打开的弹窗是同一份数据。
      // register 在默认键位与其它插件重叠时会抛错；这里必须兜住，
      // 否则一个键位冲突就会把整个浏览器端插件启动打断（按钮也一起消失）。
      ctx.effect(() => {
        try {
          return ctx.shortcuts.register({
            id: COMMAND_ID,
            label: () => t('shortcut.label'),
            aliases: ['screenshot', 'screen capture', '截图', '屏幕截图'],
            defaults: SHORTCUT_DEFAULTS,
            regions: ['page', 'editable'],
            modals: [],
            resolve: (context) => {
              // Desktop 的 priority 分发会绕过 modal 检查，这里自己挡一下：
              // 设置/快捷键弹窗开着时按快捷键不该在背后悄悄截图。
              if (context !== null && typeof context === 'object' && typeof context.modal === 'string') {
                return { status: 'blocked', reason: 'modal' }
              }
              const sessionId = findActiveSession(ctx)
              if (sessionId === undefined) return { status: 'blocked', reason: t('shortcut.blocked') }
              let shell
              try {
                shell = ctx.conversation.input.shell(sessionId)
              } catch {
                return { status: 'blocked', reason: t('shortcut.blocked') }
              }
              if (shell === undefined || shell === null) return { status: 'blocked', reason: t('shortcut.blocked') }
              if (composerFrozen(shell.snapshot?.phase)) return { status: 'blocked', reason: t('error.locked') }
              return {
                status: 'handled',
                run: () => {
                  void shortcutCapture(sessionId, shell, t)
                }
              }
            }
          })
        } catch (error) {
          // 键位被别的插件占用、或快捷键服务拒绝这次注册：降级成「只有按钮、没有默认快捷键」，
          // 设置里仍可重新录制一个不冲突的键位。
          const message = error instanceof Error ? error.message : String(error)
          console.warn('[dsh-screenshot] 快捷键注册失败：' + message)
          return () => {}
        }
      }, 'dsh-screenshot: capture shortcut')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-screenshot'
    return module.exports
  }
})
