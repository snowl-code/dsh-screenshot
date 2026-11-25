# dsh-screenshot: interactive region capture for Windows.
# Draws a translucent full-screen overlay, lets the user drag a rectangle,
# then copies that rectangle to a JPEG (longest edge capped at -MaxEdge).
#
# Exit codes: 0 saved, 3 cancelled, 2 failed.
# Usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File capture.ps1 -Out C:\temp\shot.jpg

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxEdge = 1800,
  [int]$Quality = 82,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $dpiSource = @'
using System;
using System.Runtime.InteropServices;
public static class DshDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@
  Add-Type -TypeDefinition $dpiSource
  [void][DshDpi]::SetProcessDPIAware()

  if ($Check) {
    Write-Output 'COMPILE OK'
    exit 0
  }

  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen

  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Bounds = $virtual
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.BackColor = [System.Drawing.Color]::Black
  $form.Opacity = 0.25
  $form.Cursor = [System.Windows.Forms.Cursors]::Cross
  $form.KeyPreview = $true

  $script:start = $null
  $script:rect = [System.Drawing.Rectangle]::Empty
  $script:accepted = $false

  $form.add_MouseDown({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $script:start = $eventArgs.Location
      $script:rect = New-Object System.Drawing.Rectangle($eventArgs.X, $eventArgs.Y, 0, 0)
      $form.Invalidate()
    }
  })

  $form.add_MouseMove({
    param($sender, $eventArgs)
    if ($null -ne $script:start) {
      $x1 = [Math]::Min($script:start.X, $eventArgs.X)
      $y1 = [Math]::Min($script:start.Y, $eventArgs.Y)
      $w = [Math]::Abs($script:start.X - $eventArgs.X)
      $h = [Math]::Abs($script:start.Y - $eventArgs.Y)
      $script:rect = New-Object System.Drawing.Rectangle($x1, $y1, $w, $h)
      $form.Invalidate()
    }
  })

  $form.add_MouseUp({
    param($sender, $eventArgs)
    if ($null -ne $script:start) {
      $x1 = [Math]::Min($script:start.X, $eventArgs.X)
      $y1 = [Math]::Min($script:start.Y, $eventArgs.Y)
      $w = [Math]::Abs($script:start.X - $eventArgs.X)
      $h = [Math]::Abs($script:start.Y - $eventArgs.Y)
      # Clamp the selection to the virtual screen so CopyFromScreen stays in range.
      $x1 = [Math]::Max(0, [Math]::Min($x1, $virtual.Width - 1))
      $y1 = [Math]::Max(0, [Math]::Min($y1, $virtual.Height - 1))
      $w = [Math]::Max(1, [Math]::Min($w, $virtual.Width - $x1))
      $h = [Math]::Max(1, [Math]::Min($h, $virtual.Height - $y1))
      $script:rect = New-Object System.Drawing.Rectangle($x1, $y1, $w, $h)
      $script:accepted = $true
      $form.Close()
    }
  })

  $form.add_Paint({
    param($sender, $eventArgs)
    if ($null -ne $script:start -and $script:rect.Width -gt 0 -and $script:rect.Height -gt 0) {
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 70, 160, 255), 1)
      $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 70, 160, 255))
      $eventArgs.Graphics.FillRectangle($brush, $script:rect)
      $eventArgs.Graphics.DrawRectangle($pen, $script:rect)
      $brush.Dispose()
      $pen.Dispose()
    }
  })

  $form.add_KeyDown({
    param($sender, $eventArgs)
    if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
      $script:accepted = $false
      $form.Close()
    }
  })

  [void]$form.ShowDialog()

  $rect = $script:rect
  $form.Dispose()

  if (-not $script:accepted -or $rect.Width -lt 4 -or $rect.Height -lt 4) {
    [Console]::Error.WriteLine('cancelled')
    exit 3
  }

  $absolute = New-Object System.Drawing.Rectangle(
    ($virtual.Left + $rect.X),
    ($virtual.Top + $rect.Y),
    $rect.Width,
    $rect.Height)

  # Let the overlay disappear before copying pixels.
  Start-Sleep -Milliseconds 250

  $bitmap = New-Object System.Drawing.Bitmap($absolute.Width, $absolute.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($absolute.Location, [System.Drawing.Point]::Empty, $absolute.Size)
  $graphics.Dispose()

  $longest = [Math]::Max($bitmap.Width, $bitmap.Height)
  $width = $bitmap.Width
  $height = $bitmap.Height
  if ($longest -gt $MaxEdge) {
    $scale = $MaxEdge / [double]$longest
    $width = [int][Math]::Round($bitmap.Width * $scale)
    $height = [int][Math]::Round($bitmap.Height * $scale)
    $scaled = New-Object System.Drawing.Bitmap($width, $height)
    $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
    $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaledGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scaledGraphics.DrawImage($bitmap, 0, 0, $width, $height)
    $scaledGraphics.Dispose()
    $bitmap.Dispose()
    $bitmap = $scaled
  }

  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' }
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality,
    [int64]$Quality)

  $bitmap.Save($Out, $codec, $encoderParams)
  $bitmap.Dispose()

  Write-Output ("SAVED {0}x{1}" -f $width, $height)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
