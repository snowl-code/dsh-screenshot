# dsh-screenshot

[![CI](https://github.com/snowl-code/dsh-screenshot/actions/workflows/ci.yml/badge.svg)](https://github.com/snowl-code/dsh-screenshot/actions/workflows/ci.yml)

在 DSH 输入框左下工具条（`+` 旁边）加一个相机按钮：点一下就能框选屏幕区域，截图直接进当前草稿的附件栏，输完问题一起发出去。支持 macOS 与 Windows 桌面端。

## 安装

```bash
git clone https://github.com/snowl-code/dsh-screenshot.git
```

在 DSH 里用插件管理器安装本地目录（`link:` 后面换成这个仓库的绝对路径）：

```bash
plugin_manager(install_bundle, "link:/absolute/path/to/dsh-screenshot")
```

- 同名包已装时 `install_bundle` 会报 `already-installed`，先 `remove_bundle` 再装。
- 仓库自带编译好的 `bin/dsh-hotkey`（macOS / Apple Silicon）。Intel 或其它架构请执行 `./helper/build.sh` 重新编译。
- Windows 不需要编译任何东西：框选与全局热键都是随包发布的 PowerShell 脚本（系统自带的 Windows PowerShell 即可）。

## 使用

1. 点输入框左下角的相机按钮。
2. 屏幕变十字准星，拖拽框选区域（macOS 可再按空格切换窗口选择；`Esc` 取消）。
3. 松开后约 1 秒，截图以缩略图出现在输入框上方的附件栏。
4. 正常输入问题并发送，图片随消息一起送达。

### 快捷键

按钮注册了 DSH 原生快捷键命令 `dsh-screenshot.capture`：

| 运行环境 | 默认键位 |
| --- | --- |
| DSH Desktop（macOS / Windows / Linux） | `⌘⌥S` / `Ctrl+Alt+S` |
| 浏览器（macOS / Windows） | `⌘⌥S` / `Ctrl+Alt+S` |
| 浏览器（Linux） | 默认不绑定 |

> 默认键位刻意避开 `⌘⇧S` / `Ctrl+Shift+S`：`dsh-pet` 的 `pet-chat.capture` 占用了该组合，快捷键服务在注册期会抛 `Conflicting shortcut defaults`，导致插件启动失败。改键时也请避开已占用组合，冲突的命令会在快捷键弹窗里标红且不生效。

触发顺序与点按钮一致：框选 → 图片进当前对话框的附件栏 → 光标回到输入框。没有可接收的对话框、或输入框正忙（发送/排队中）时命令不动作；截图失败会在输入框提示（取消不提示）。

改键入口就是 DSH 自带的快捷键设置：**设置 → 通用 → 快捷键**（`⌘/` 或 `Ctrl+/` 也能打开），搜「截图」即可录制新键位、清除绑定或恢复默认。按钮的悬浮提示会实时显示当前键帽。

### 全局快捷键：在别的应用里也能按

上面那个快捷键本身只在 DSH 窗口有焦点时生效（DSH Desktop 的快捷键运行时是网页模式，窗口失焦就收不到 keydown）。为了在微信、浏览器、Finder 里也能直接框选，插件带了一个按平台选择的系统级热键辅助程序：

- 宿主插件启动后按设置里的当前键位拉起辅助程序：macOS 用 `bin/dsh-hotkey`（Carbon `RegisterEventHotKey`，不需要辅助功能权限），Windows 用 `bin/win/hotkey.ps1`（`RegisterHotKey`，由系统自带的 PowerShell 运行）；
- DSH 在后台时按 `⌘⌥S` / `Ctrl+Alt+S`（或你在设置里改成的任何键位），照样弹出框选；宿主截完图后把图片排队，页面轮询取走并放进当前对话框的附件栏；
- DSH 回到前台时辅助程序会临时注销热键，把按键让给应用内快捷键，两者不会重复截图；
- 在 **设置 → 通用 → 快捷键** 里改一次键位，辅助程序会自动跟着换，不用单独配置；
- 双键和弦、没有修饰键、或无法映射成当前平台虚拟键码的组合不会注册成全局热键（应用内仍然可用）；系统或其它应用占用了同一组合时，`RegisterHotKey` 会失败并退回「应用内快捷键仍可用」。

辅助程序只在 DSH 运行期间存在，随 DSH 退出而退出，不需要 LaunchAgent 或登录项。它不碰屏幕内容——截图仍然由 DSH 进程执行；辅助程序只负责「把热键按下的消息告诉宿主」。

截图区域长边会被压到 1800px、JPEG 质量 82（原图更大时再压到 1280px），避免撑爆上下文。

## 系统要求

- **macOS**：截屏走系统 `screencapture -i`，需要在「系统设置 → 隐私与安全性 → 屏幕录制」里给 DSH Desktop 授权；未授权时按钮会提示「需要屏幕录制权限」。全局热键的辅助程序需要 `bin/dsh-hotkey` 与当前 Mac 架构匹配，换机器或换架构后用 `helper/build.sh` 重新编译。
- **Windows 10/11**：框选与全局热键都由系统自带的 Windows PowerShell 5.1 执行（`bin/win/capture.ps1` / `bin/win/hotkey.ps1`），不需要安装额外工具，也没有屏幕录制授权步骤。PowerShell 被策略禁用或路径异常时，按钮会提示启动失败，应用内快捷键仍然可用。
- 全局热键只有在 DSH Desktop 运行期间可用（辅助程序是它的子进程）。
- 其它平台会返回 `unsupported-platform`（按钮提示不支持）。
- 测试状态：macOS 分支已在真机验证；Windows 分支按 Windows 10/11 自带 PowerShell 5.1 编写，尚未在真机回归，遇到问题请开 issue。

## 实现结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主侧：注册 HTTP 路由，按平台调用 `screencapture` + `sips` 或 PowerShell 框选；维护全局热键辅助程序与待取截图队列；把页面上报的抽象键位翻译成 Carbon / Windows VK |
| `lib/client.js` | 浏览器侧：注册 `conversation.input.left` 槽位按钮与 `dsh-screenshot.capture` 快捷键命令，拿到图片后走官方草稿附件 API；同步键位、轮询全局截图 |
| `helper/hotkey.swift` | 全局热键辅助程序源码（Carbon `RegisterEventHotKey` + `NSApplication` 事件循环 + 前后台切换时让键；裸 `RunLoop` 收不到 Carbon 热键事件） |
| `bin/dsh-hotkey` | macOS 辅助程序，由 `helper/build.sh` 生成，随包发布 |
| `bin/win/capture.ps1` | Windows 框选截图（全屏半透明遮罩 + `CopyFromScreen` + JPEG 缩放） |
| `bin/win/hotkey.ps1` | Windows 全局热键（内嵌 C# `RegisterHotKey` + 消息循环 + 前后台切换时让键） |
| `cordis.patch.yml` | bundle 插件条目（`insert: dsh-screenshot`） |

### 路由契约

```
POST /dsh-screenshot-capture/capture
Header: x-dsh-screenshot: 1        (缺失 → 403，用于挡跨站请求)
→ 200 { ok: true, dataUrl, mime, name }
→ 200 { ok: false, code: "cancelled" | "permission" | "unsupported-platform" | "failed" }
```

全局热键相关路由（都要求 `x-dsh-screenshot: 1` 头，`GET /pending` 除外）：

```
GET  /dsh-screenshot-capture/pending  → { ok: true, items: [{ id, dataUrl, mime, name, at }] }
POST /dsh-screenshot-capture/take     ← { id }          页面确认已入草稿
POST /dsh-screenshot-capture/hotkey   ← { code, modifiers } 或 { keycode, mods }（旧版）或 { enabled: false }
GET  /dsh-screenshot-capture/status   → { ok, platform, supported, active, lastTriggerAt, pending, helperKey, helperKind, helperLog }
```

非 POST（capture/take/hotkey）回 405，其它路径回 404。截图请求经 `enqueue()` 串行化，同时只允许一次框选；全局热键的截图最多在宿主队列里滞留 3 张，页面取走前一直保留。

### 桌面端为什么不用 getDisplayMedia

DSH Desktop 主窗口的 session 没有注册 `setDisplayMediaRequestHandler`，`navigator.mediaDevices.getDisplayMedia()` 会被拒绝。所以桌面端（UA 含 `Electron/`）走宿主 `screencapture`；用普通浏览器打开同一个 Web GUI 时自动退回 `getDisplayMedia` + canvas 路径。

### 往草稿里塞图

```js
const conversation = ctx.get('conversation')
const shell = conversation.input.shell(sessionId)       // 无绑定时会 throw
const drafts = conversation.createDrafts(sessionId, [file], true)
if (shell.addFiles([], drafts.map(d => d.id)) !== true) {
  conversation.releaseDraftAttachments(drafts)
}
```

## 开发

- 客户端 smoke：`npm test` —— 在 Node 里用假的 DSH 运行时加载 `lib/client.js`，验证命令注册、键位同步、槽位挂载和全局截图链路，不需要 DSH 本体。
- 键位映射 smoke：`npm run test:keys` —— 验证抽象键位到 Carbon / Windows VK 的翻译（含旧版 `keycode/mods` 兼容）。
- 宿主 smoke（仅 macOS）：`npm run test:host` —— 起假的宿主 ctx，验证路由、参数校验、辅助程序拉起/停止和截图队列。
- 重新编译全局热键辅助程序：`./helper/build.sh`（需要 Xcode Command Line Tools，`swiftc` 6.1+）。

**改完怎么生效**：客户端 bundle 由宿主在启动时构建并缓存在内存里，所以改了 `lib/client.js` 必须升级版本号 → `remove_bundle` + `install_bundle` → 完全退出并重开 DSH Desktop 才生效（`remove_bundle` 本身也是延迟到重启才真正移除）。

## License

[MIT](./LICENSE)
