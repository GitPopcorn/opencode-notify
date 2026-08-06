# Deploy kdco-notify-win to an OpenCode plugins directory.
#
# IMPORTANT: OpenCode only auto-loads plugins that are DIRECT .js/.ts files in
# the plugins directory (or its config dir). It does NOT recurse into
# subdirectories. So this script flattens the plugin package's contents
# (the .js entry + vendored node_modules + assets) into the plugins root.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Target global
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Target "E:\path\to\project"

param(
    # "global" (-> ~/.config/opencode/plugins) or an absolute project dir whose
    # `.opencode\plugins` will receive the plugin.
    [string]$Target = "global"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot "dist\kdco-notify-win"

if ($Target -eq "global") {
    $pluginsDir = Join-Path $HOME ".config\opencode\plugins"
} else {
    $pluginsDir = Join-Path (Resolve-Path $Target) ".opencode\plugins"
}

Write-Host "Deploying to: $pluginsDir"

if (-not (Test-Path $src)) { throw "Source package not found: $src" }
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

# Flatten: entry .js, plugin-logger.js, node_modules, assets go straight into the
# plugins root.
Copy-Item -Force (Join-Path $src "kdco-notify-win.js") $pluginsDir
Copy-Item -Force (Join-Path $src "plugin-logger.js") $pluginsDir
Copy-Item -Recurse -Force (Join-Path $src "assets") $pluginsDir
Copy-Item -Recurse -Force (Join-Path $src "node_modules") $pluginsDir

# Remove any leftover click-helper script from older deploys (the helper-based
# jump-to-opencode approach was removed; click-to-open now uses clickMode
# "program"/"native" inside the plugin).
$leftoverHelper = Join-Path $pluginsDir "jump-to-opencode.ps1"
if (Test-Path -LiteralPath $leftoverHelper) {
    Remove-Item -LiteralPath $leftoverHelper -Force
    Write-Host "  removed leftover helper: jump-to-opencode.ps1"
}

Write-Host "Done. Restart OpenCode to load the plugin."
Write-Host "  entry:     $pluginsDir\kdco-notify-win.js"
Write-Host "  logger:    $pluginsDir\plugin-logger.js"
Write-Host "  assets:    $pluginsDir\assets"
Write-Host "  deps:      $pluginsDir\node_modules"
