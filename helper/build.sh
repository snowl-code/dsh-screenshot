#!/bin/sh
# 重新编译 bin/dsh-hotkey（需要 Xcode Command Line Tools 里的 swiftc）。
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O -swift-version 5 helper/hotkey.swift -o bin/dsh-hotkey
chmod +x bin/dsh-hotkey
echo "built bin/dsh-hotkey"
