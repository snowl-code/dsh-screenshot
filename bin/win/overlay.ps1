# dsh-screenshot: shared Windows selection overlay.
#
# Both capture.ps1 (one-shot, used as a fallback) and capture-agent.ps1 (the warm
# process the host keeps alive) dot-source this file. It defines:
#
#   New-DshSnapshot  - freeze the whole virtual screen into a Bitmap
#   Invoke-DshSelect - show the rubber-band overlay over that Bitmap
#   Save-DshJpeg     - crop the chosen rectangle and encode it as JPEG
#
# Why the overlay paints a frozen snapshot instead of the live screen: the band
# is redrawn from an in-memory image, so dragging cannot flicker, the dim layer
# can never end up in the saved image, and there is no "let the overlay vanish"
# sleep before copying pixels.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ([System.Management.Automation.PSTypeName]'DshScreenshotNative').Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshScreenshotNative {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@
}
[void][DshScreenshotNative]::SetProcessDPIAware()

# Grow a selection into a rectangle wide enough to also cover its 1px border and
# the size label drawn above it, so Invalidate() repaints everything that changed.
function New-DshDirtyRect {
  param([System.Drawing.Rectangle]$Rect)
  $padX = 4
  $padTop = 34
  $padBottom = 4
  return New-Object System.Drawing.Rectangle(
    ($Rect.X - $padX),
    ($Rect.Y - $padTop),
    ($Rect.Width + ($padX * 2)),
    ($Rect.Height + $padTop + $padBottom))
}

# Freeze the virtual screen (all monitors, physical pixels because the process is
# DPI aware) into a 32bpp bitmap. The cursor is not included.
function New-DshSnapshot {
  param([Parameter(Mandatory = $true)][System.Drawing.Rectangle]$Virtual)

  $bitmap = New-Object System.Drawing.Bitmap(
    $Virtual.Width,
    $Virtual.Height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(
      $Virtual.Left,
      $Virtual.Top,
      0,
      0,
      $bitmap.Size,
      [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

# Show the overlay and let the user drag a rectangle. Returns
#   @{ ok = $true;  rect = <Rectangle in snapshot coordinates> }
#   @{ ok = $false; reason = 'cancelled' }
function Invoke-DshSelect {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Bitmap]$Snapshot,
    [Parameter(Mandatory = $true)][System.Drawing.Rectangle]$Virtual
  )

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'dsh-screenshot-overlay'
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Bounds = $Virtual
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.Cursor = [System.Windows.Forms.Cursors]::Cross
  $form.KeyPreview = $true
  $form.BackColor = [System.Drawing.Color]::Black

  # Double buffering + self painting: only the dirty rectangle is repainted while
  # the band moves, which is what removes the flicker of the old layered window.
  $styles = [int](
    [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer -bor
    [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
    [System.Windows.Forms.ControlStyles]::UserPaint)
  $setStyle = [System.Windows.Forms.Control].GetMethod(
    'SetStyle',
    [System.Reflection.BindingFlags]'Instance,NonPublic')
  $setStyle.Invoke($form, @($styles, $true))

  $script:dshSnap = $Snapshot
  $script:dshWidth = $Virtual.Width
  $script:dshHeight = $Virtual.Height
  $script:dshStart = $null
  $script:dshSel = [System.Drawing.Rectangle]::Empty
  $script:dshAccepted = $false

  $script:dshFont = New-Object System.Drawing.Font(
    'Segoe UI',
    9,
    [System.Drawing.FontStyle]::Regular,
    [System.Drawing.GraphicsUnit]::Pixel)
  $script:dshPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0, 174, 255), 1)
  $script:dshDim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 0, 0, 0))
  $script:dshLabelBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(205, 20, 20, 20))
  $script:dshLabelFg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

  $form.add_MouseDown({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
      $script:dshAccepted = $false
      $sender.Close()
      return
    }
    if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    $script:dshStart = $eventArgs.Location
    $script:dshSel = New-Object System.Drawing.Rectangle($eventArgs.X, $eventArgs.Y, 0, 0)
    $sender.Invalidate()
  })

  $form.add_MouseMove({
    param($sender, $eventArgs)
    if ($null -eq $script:dshStart) { return }
    $rect = New-Object System.Drawing.Rectangle(
      [Math]::Min($script:dshStart.X, $eventArgs.X),
      [Math]::Min($script:dshStart.Y, $eventArgs.Y),
      [Math]::Abs($script:dshStart.X - $eventArgs.X),
      [Math]::Abs($script:dshStart.Y - $eventArgs.Y))
    $previous = $script:dshSel
    $script:dshSel = $rect
    if ($previous.Width -gt 0 -or $previous.Height -gt 0) {
      $sender.Invalidate((New-DshDirtyRect -Rect $previous))
    }
    $sender.Invalidate((New-DshDirtyRect -Rect $rect))
  })

  $form.add_MouseUp({
    param($sender, $eventArgs)
    if ($null -eq $script:dshStart) { return }
    if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    # Clamp into the snapshot so the crop stays in range on multi-monitor setups.
    $left = [Math]::Min($script:dshStart.X, $eventArgs.X)
    $top = [Math]::Min($script:dshStart.Y, $eventArgs.Y)
    $width = [Math]::Abs($script:dshStart.X - $eventArgs.X)
    $height = [Math]::Abs($script:dshStart.Y - $eventArgs.Y)
    $left = [Math]::Max(0, [Math]::Min($left, $script:dshWidth - 1))
    $top = [Math]::Max(0, [Math]::Min($top, $script:dshHeight - 1))
    $width = [Math]::Max(1, [Math]::Min($width, $script:dshWidth - $left))
    $height = [Math]::Max(1, [Math]::Min($height, $script:dshHeight - $top))
    $script:dshSel = New-Object System.Drawing.Rectangle($left, $top, $width, $height)
    $script:dshAccepted = $true
    $sender.Close()
  })

  $form.add_KeyDown({
    param($sender, $eventArgs)
    if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
      $script:dshAccepted = $false
      $sender.Close()
    }
  })

  $form.add_Paint({
    param($sender, $eventArgs)
    $graphics = $eventArgs.Graphics
    $graphics.DrawImageUnscaled($script:dshSnap, 0, 0)

    $sel = $script:dshSel
    if ($sel.Width -le 0 -or $sel.Height -le 0) {
      $graphics.FillRectangle($script:dshDim, 0, 0, $script:dshWidth, $script:dshHeight)
      return
    }

    # Dim everything outside the selection; the selection keeps the frozen pixels.
    $graphics.FillRectangle($script:dshDim, 0, 0, $script:dshWidth, $sel.Top)
    $graphics.FillRectangle($script:dshDim, 0, $sel.Bottom, $script:dshWidth, ($script:dshHeight - $sel.Bottom))
    $graphics.FillRectangle($script:dshDim, 0, $sel.Top, $sel.Left, $sel.Height)
    $graphics.FillRectangle($script:dshDim, $sel.Right, $sel.Top, ($script:dshWidth - $sel.Right), $sel.Height)

    $graphics.DrawRectangle(
      $script:dshPen,
      $sel.Left,
      $sel.Top,
      [Math]::Max(0, $sel.Width - 1),
      [Math]::Max(0, $sel.Height - 1))

    # Size readout, the same thing macOS shows while dragging.
    $text = '{0} {1} {2}' -f $sel.Width, [char]0x00D7, $sel.Height
    $size = $graphics.MeasureString($text, $script:dshFont)
    $labelX = $sel.Left
    $labelY = $sel.Top - $size.Height - 6
    if ($labelY -lt 0) { $labelY = $sel.Top + 4 }
    if (($labelX + $size.Width + 10) -gt $script:dshWidth) {
      $labelX = [Math]::Max(0, $script:dshWidth - $size.Width - 12)
    }
    $graphics.FillRectangle($script:dshLabelBg, $labelX, $labelY, ($size.Width + 8), $size.Height)
    $graphics.DrawString($text, $script:dshFont, $script:dshLabelFg, ($labelX + 4), $labelY)
  })

  [void]$form.ShowDialog()

  $rect = $script:dshSel
  $accepted = $script:dshAccepted
  $form.Dispose()

  $script:dshFont.Dispose()
  $script:dshPen.Dispose()
  $script:dshDim.Dispose()
  $script:dshLabelBg.Dispose()
  $script:dshLabelFg.Dispose()

  if (-not $accepted -or $rect.Width -lt 4 -or $rect.Height -lt 4) {
    return @{ ok = $false; reason = 'cancelled' }
  }
  return @{ ok = $true; rect = $rect }
}

# Crop -Rect out of -Snapshot, scale the long edge down to -MaxEdge and write a
# JPEG at -Out. Returns @{ width; height } of the encoded image.
function Save-DshJpeg {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Bitmap]$Snapshot,
    [Parameter(Mandatory = $true)][System.Drawing.Rectangle]$Rect,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$MaxEdge = 1800,
    [int]$Quality = 82
  )

  $crop = $Snapshot.Clone($Rect, $Snapshot.PixelFormat)
  $scaled = $null
  try {
    $bitmap = $crop
    $longest = [Math]::Max($crop.Width, $crop.Height)
    if ($longest -gt $MaxEdge -and $longest -gt 0) {
      $scale = $MaxEdge / [double]$longest
      $width = [int][Math]::Round($crop.Width * $scale)
      $height = [int][Math]::Round($crop.Height * $scale)
      $scaled = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($scaled)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($crop, 0, 0, $width, $height)
      } finally {
        $graphics.Dispose()
      }
      $bitmap = $scaled
    }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' }
    $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality,
      [int64]$Quality)
    $bitmap.Save($Out, $codec, $encoderParams)

    return @{ width = $bitmap.Width; height = $bitmap.Height }
  } finally {
    if ($null -ne $scaled) { $scaled.Dispose() }
    $crop.Dispose()
  }
}
