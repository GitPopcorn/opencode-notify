# jump-to-opencode.ps1
# ====================
# Best-effort "click the notification -> land in the OpenCode terminal" helper.
#
# Behavior (as decided):
#   1. If a Windows Terminal (wt.exe) process is ALREADY running -> bring the
#      most relevant window to the foreground (current tab stays as-is). This is
#      the "just switch to the existing wt.exe" behavior.
#   2. Only if NO wt.exe is running -> open a fresh Windows Terminal tab running
#      `opencode` in the session's working directory (or the current directory).
#
# The "precise tab pinning" goal (naming the exact tab of the exact session) is
# intentionally NOT attempted: Windows Terminal exposes no stable public CLI to
# focus an arbitrary tab by title, so this focuses the matching WINDOW instead
# (window title mirrors the focused tab, so it is usually good enough).
#
# Invoked by the plugin (clickMode = "helper") with the session's title / cwd.
# Exits 0 on success; the plugin falls back to a plain `wt.exe` launch if the
# script is missing or exits non-zero.

param(
    [string]$Title = "",
    [string]$Cwd = "",
    [string]$SessionId = ""
)

$ErrorActionPreference = "Stop"

function Get-WtProcesses {
    Get-Process -Name "wt" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 }
}

$wt = @(Get-WtProcesses)

if ($wt.Count -eq 0) {
    # No Windows Terminal running -> open a fresh tab (new window).
    $arg = @()
    if ($Cwd -and (Test-Path -LiteralPath $Cwd)) {
        $arg += @("-d", $Cwd)
    }
    $arg += "opencode"
    Start-Process -FilePath "wt.exe" -ArgumentList $arg | Out-Null
    exit 0
}

# Prefer the window whose title matches the session title, then any "opencode".
$candidate = $null
if ($Title) {
    $candidate = $wt |
        Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($Title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        Select-Object -First 1
}
if (-not $candidate) {
    $candidate = $wt |
        Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf("opencode", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        Select-Object -First 1
}
if (-not $candidate) {
    $candidate = $wt | Sort-Object { $_.StartTime } -Descending | Select-Object -First 1
}
if (-not $candidate) {
    exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class KdcoForeground {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
# SW_RESTORE (9) then bring to front. Best-effort; the call can be rejected by
# Windows focus-stealing prevention, which is acceptable.
[KdcoForeground]::ShowWindow($candidate.MainWindowHandle, 9) | Out-Null
[KdcoForeground]::SetForegroundWindow($candidate.MainWindowHandle) | Out-Null

exit 0
