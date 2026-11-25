//
// dsh-hotkey —— dsh-screenshot 的 macOS 全局热键辅助程序
//
// 由宿主插件（lib/index.js）在 DSH 启动后 spawn 成子进程，随 DSH 退出而退出。
//   dsh-hotkey --key <虚拟键码> --mods <Carbon 修饰键掩码>
//
// 行为：
//   * 用 Carbon 的 RegisterEventHotKey 注册系统级热键（不需要辅助功能权限）；
//     事件循环用 NSApplication.run()（裸 RunLoop 不会分发 Carbon 热键事件）；
//   * 按下热键时向 stdout 打一行 "TRIGGER"，宿主据此调用 screencapture；
//   * 每 0.4 秒看一次前台 App：DSH Desktop 在前台时注销热键，把按键让给
//     应用内快捷键，避免系统级热键吞掉 keydown；DSH 在后台时重新注册。
//
// stdout 协议（宿主只依赖 TRIGGER，其余用于状态诊断）：
//   READY 0 | READY deferred | ACQUIRED | RELEASED | FRONT <bundleId> | TRIGGER | ERROR <status>
//

import AppKit
import Carbon.HIToolbox

/// DSH Desktop 的 bundle id：它在前台时让出热键。
private let targetBundleIdentifier = "io.dsh.desktop"

/// 'DSHS'
private let hotKeySignature: OSType = 0x44_53_48_53
private let hotKeyIdentifier: UInt32 = 1

private var hotKeyRef: EventHotKeyRef?
private var hotKeyRegistered = false
private var keyCode: UInt32 = 1
/// 默认 ⌘⌥S（cmdKey | optionKey）。
private var modifierMask: UInt32 = UInt32(cmdKey | optionKey)
private var reportedError: OSStatus = 0

private func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

@discardableResult
private func registerHotKey() -> Bool {
    if hotKeyRegistered { return true }
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(
        keyCode,
        modifierMask,
        EventHotKeyID(signature: hotKeySignature, id: hotKeyIdentifier),
        GetApplicationEventTarget(),
        0,
        &ref
    )
    hotKeyRef = ref
    hotKeyRegistered = status == noErr
    if !hotKeyRegistered {
        if status != reportedError {
            reportedError = status
            emit("ERROR \(status)")
        }
    } else {
        reportedError = 0
    }
    return hotKeyRegistered
}

private func unregisterHotKey() {
    if let ref = hotKeyRef {
        UnregisterEventHotKey(ref)
    }
    hotKeyRef = nil
    hotKeyRegistered = false
}

private func installEventHandler() {
    var spec = EventTypeSpec(
        eventClass: OSType(kEventClassKeyboard),
        eventKind: UInt32(kEventHotKeyPressed)
    )
    InstallEventHandler(
        GetApplicationEventTarget(),
        { _, event, _ -> OSStatus in
            guard let event else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &identifier
            )
            guard status == noErr else { return status }
            guard identifier.signature == hotKeySignature, identifier.id == hotKeyIdentifier else {
                return OSStatus(eventNotHandledErr)
            }
            emit("TRIGGER")
            return noErr
        },
        1,
        &spec,
        nil,
        nil
    )
}

private func parseArguments() {
    let args = CommandLine.arguments
    var index = 1
    while index < args.count {
        switch args[index] {
        case "--key":
            if index + 1 < args.count, let value = UInt32(args[index + 1]) {
                keyCode = value
                index += 1
            }
        case "--mods":
            if index + 1 < args.count, let value = UInt32(args[index + 1]) {
                modifierMask = value
                index += 1
            }
        default:
            break
        }
        index += 1
    }
}

private func frontmostBundleIdentifier() -> String {
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
}

private func syncWithFrontmostApp() {
    let front = frontmostBundleIdentifier()
    if front == targetBundleIdentifier {
        if hotKeyRegistered {
            unregisterHotKey()
            emit("RELEASED")
        }
    } else if !hotKeyRegistered {
        if registerHotKey() {
            emit("ACQUIRED")
        }
    }
}

// NSApplication 的 run loop 才会分发 Carbon 热键事件；普通 RunLoop.run() 只
// 能注册成功、按键却到不了事件处理器。accessory 策略避免出现 Dock 图标。
let application = NSApplication.shared
application.setActivationPolicy(.accessory)

installEventHandler()
parseArguments()

let startFrontmost = frontmostBundleIdentifier()
emit("FRONT \(startFrontmost)")
syncWithFrontmostApp()
emit(hotKeyRegistered ? "READY 0" : "READY deferred")

let monitor = Timer(timeInterval: 0.4, repeats: true) { _ in
    syncWithFrontmostApp()
}
RunLoop.main.add(monitor, forMode: .common)

application.run()
