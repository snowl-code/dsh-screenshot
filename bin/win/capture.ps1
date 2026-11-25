# dsh-screenshot: one-shot interactive region capture for Windows.
#
# This is the fallback path: the host normally keeps capture-agent.ps1 warm and
# sends it the command over stdin, so no PowerShell process has to start per
# capture. If the agent is unavailable the host runs this script instead; it
# uses the same overlay and the same JPEG encoding as the agent.
#
# Exit codes: 0 saved, 3 cancelled, 2 failed.
# Usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File capture.ps1 -Out C:\temp\shot.jpg
# Check:  ... -File capture.ps1 -Out C:\temp\shot.jpg -Check   -> "COMPILE OK <w>x<h>"

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxEdge = 1800,
  [int]$Quality = 82,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

try {
  . (Join-Path $PSScriptRoot 'overlay.ps1')

  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen

  if ($Check) {
    # End-to-end self check that needs no user interaction: snapshot the corner of
    # the screen, crop 320x200 and encode it, so a broken capture/encode path is
    # reported here instead of in the middle of a real selection.
    $snapshot = New-DshSnapshot -Virtual $virtual
    try {
      $rect = New-Object System.Drawing.Rectangle(
        0,
        0,
        [Math]::Min(320, $virtual.Width),
        [Math]::Min(200, $virtual.Height))
      $info = Save-DshJpeg -Snapshot $snapshot -Rect $rect -Out $Out -MaxEdge $MaxEdge -Quality $Quality
      Write-Output ('COMPILE OK {0}x{1}' -f $info.width, $info.height)
    } finally {
      $snapshot.Dispose()
    }
    exit 0
  }

  # Freeze the screen first: the overlay then paints that image, so the band never
  # flickers and the saved pixels cannot contain the dim layer.
  $snapshot = New-DshSnapshot -Virtual $virtual
  try {
    $picked = Invoke-DshSelect -Snapshot $snapshot -Virtual $virtual
    if (-not $picked.ok) {
      [Console]::Error.WriteLine('cancelled')
      exit 3
    }
    $info = Save-DshJpeg -Snapshot $snapshot -Rect $picked.rect -Out $Out -MaxEdge $MaxEdge -Quality $Quality
    Write-Output ('SAVED {0}x{1}' -f $info.width, $info.height)
  } finally {
    $snapshot.Dispose()
  }

  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
