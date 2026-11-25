# dsh-screenshot: warm capture agent for Windows.
#
# Starting powershell.exe costs about a second on this machine (measured: bare
# `powershell -Command` ~1.1s, +WinForms ~1.4s, +C# compile ~1.5s). Spawning it
# per capture is what made the button and the global hotkey feel slow, so the
# host starts this script once and keeps it alive:
#
#   host -> CAPTURE <id> <maxEdge> <quality> <out path>       (one line on stdin)
#   agent -> DONE <id> <w>x<h> | CANCEL <id> | ERR <id> <message>
#   agent -> READY                                          (once, after warmup)
#   PING  -> PONG                                           (liveness probe)
#   EXIT  -> shut down; stdin EOF does the same
#
# The visible work (snapshot, rubber band, JPEG) is shared with capture.ps1
# through overlay.ps1, so both paths look and behave the same.

$ErrorActionPreference = 'Stop'

# Agree with the host on UTF-8 for both directions: the capture path is passed
# over stdin and can contain non-ASCII characters (user named temp directories).
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # Redirected streams reject the assignment on some hosts; ASCII paths still work.
}

. (Join-Path $PSScriptRoot 'overlay.ps1')

$stdout = [Console]::Out

# Pay the one-time costs (JIT, GDI+, screen enumeration, first snapshot) before
# READY, so the first hotkey press is already fast.
try {
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $probeWidth = [Math]::Max(1, [Math]::Min(64, $virtual.Width))
  $probeHeight = [Math]::Max(1, [Math]::Min(64, $virtual.Height))
  $probe = New-DshSnapshot -Virtual (New-Object System.Drawing.Rectangle(0, 0, $probeWidth, $probeHeight))
  $probe.Dispose()
} catch {
  $stdout.WriteLine('ERR 0 warmup: ' + $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' '))
}

$stdout.WriteLine('READY')
$stdout.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }        # host is gone
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  if ($line -eq 'EXIT') { break }
  if ($line -eq 'PING') {
    $stdout.WriteLine('PONG')
    $stdout.Flush()
    continue
  }
  if (-not $line.StartsWith('CAPTURE ')) {
    $stdout.WriteLine('ERR 0 unknown command')
    $stdout.Flush()
    continue
  }

  # CAPTURE <id> <maxEdge> <quality> <out path>  -- the path may contain spaces.
  $rest = $line.Substring(8)
  $parts = $rest -split ' ', 4
  if ($parts.Length -lt 4) {
    $stdout.WriteLine('ERR 0 bad command')
    $stdout.Flush()
    continue
  }
  $id = $parts[0]
  $maxEdge = [int]$parts[1]
  $quality = [int]$parts[2]
  $outPath = $parts[3]

  try {
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $snapshot = New-DshSnapshot -Virtual $virtual
    try {
      $picked = Invoke-DshSelect -Snapshot $snapshot -Virtual $virtual
      if (-not $picked.ok) {
        $stdout.WriteLine('CANCEL ' + $id)
      } else {
        $info = Save-DshJpeg -Snapshot $snapshot -Rect $picked.rect -Out $outPath -MaxEdge $maxEdge -Quality $quality
        $stdout.WriteLine(('DONE {0} {1}x{2}' -f $id, $info.width, $info.height))
      }
    } finally {
      $snapshot.Dispose()
    }
  } catch {
    $message = $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' ')
    $stdout.WriteLine('ERR ' + $id + ' ' + $message)
  }
  $stdout.Flush()
}
