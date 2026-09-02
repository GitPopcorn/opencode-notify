# Deploy kdco-notify-win to an OpenCode config directory.
#
# OpenCode loads plugins in ONE of two ways:
#   1. AUTO-DISCOVERY of direct .js/.ts files in the plugins dir — NOT used here.
#   2. EXPLICIT `plugin` array in opencode.json(c) — this is how we register.
#
# Because kdco-notify-win is registered explicitly (config-managed: remove the
# entry to disable), the whole plugin package is deployed as a SUBDIRECTORY:
#   <config-dir>/plugins/kdco-notify-win/  (index.js + node_modules + assets)
# and opencode.json(c) references it via a file:// URL with optional tuple
# options (P1/P3).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Target global
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Target "E:\path\to\project"

param(
    # "global" (-> ~/.config/opencode) or an absolute project dir whose
    # `.opencode` will receive the plugin.
    [string]$Target = "global"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot "dist\kdco-notify-win"
$id = "kdco-notify-win"

if ($Target -eq "global") {
    $configRoot = Join-Path $HOME ".config\opencode"
} else {
    $configRoot = Resolve-Path (Join-Path $Target ".opencode")
}

$pluginsDir = Join-Path $configRoot "plugins"
$dest = Join-Path $pluginsDir $id

Write-Host "Deploying to: $dest"

if (-not (Test-Path $src)) { throw "Source package not found: $src" }

# Whole package folder: index.js, plugin-logger.js, package.json, node_modules,
# assets, and kdco-notify-win.sample.jsonc (inert template, never loaded).
# Copy contents so a redeploy refreshes code.
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force (Join-Path $src "index.js") $dest
Copy-Item -Force (Join-Path $src "plugin-logger.js") $dest
Copy-Item -Force (Join-Path $src "package.json") $dest
Copy-Item -Recurse -Force (Join-Path $src "node_modules") (Join-Path $dest "node_modules")
Copy-Item -Recurse -Force (Join-Path $src "assets") (Join-Path $dest "assets")
Copy-Item -Force (Join-Path $src "kdco-notify-win.sample.jsonc") $dest

# Project-level config (P2): write a template-derived config to the PROJECT's own
# `.opencode\plugins\config\kdco-notify-win.jsonc`, the only file-based config
# layer. Only written when absent so redeploys never clobber the user's edits.
# Any stale `kdco-notify.jsonc`/`kdco-notify.json` is removed so it can't shadow
# the new file with old settings.
if ($Target -ne "global") {
    $projectRoot = Resolve-Path $Target
    $configDir = Join-Path $projectRoot ".opencode\plugins\config"
    $configDest = Join-Path $configDir "kdco-notify-win.jsonc"
    $configSrc = Join-Path $src "kdco-notify-win.sample.jsonc"
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    if (-not (Test-Path $configDest)) {
        Copy-Item -Force $configSrc $configDest
        Write-Host "  config:    $configDest (template-derived config (defaults, logging off))"
    } else {
        Write-Host "  config:    $configDest (exists, left untouched)"
    }
    foreach ($legacy in @("kdco-notify.jsonc", "kdco-notify.json")) {
        $legacyPath = Join-Path $configDir $legacy
        if (Test-Path -LiteralPath $legacyPath) {
            Remove-Item -LiteralPath $legacyPath -Force
            Write-Host "  removed legacy config: $legacyPath"
        }
    }
}

# Old flat deploys put files directly in the plugins root; clean those up so a
# stale entry .js/plugin-logger.js can't shadow the new config-managed install.
foreach ($stale in @("kdco-notify-win.js", "plugin-logger.js", "jump-to-opencode.ps1")) {
    $stalePath = Join-Path $pluginsDir $stale
    if (Test-Path -LiteralPath $stalePath) {
        Remove-Item -LiteralPath $stalePath -Force
        Write-Host "  removed stale flat deploy: $stalePath"
    }
}

# Old deploys shipped a bundled default config at <dest>\config\kdco-notify-win.jsonc
# (P6). New design ships NO config file in the package — P6 is an empty slot and
# the annotated template lives at <dest>\kdco-notify-win.sample.jsonc (inert).
# Remove a stale auto-deployed bundled default (identified by its
# "BUNDLED DEFAULT" header) so it can't be picked up as a P6 layer; a
# user-placed config in config/ (custom header) is left untouched.
$pkgConfigDir = Join-Path $dest "config"
if (Test-Path -LiteralPath $pkgConfigDir) {
    foreach ($legacy in @("kdco-notify-win.jsonc", "kdco-notify-win.json", "kdco-notify.jsonc", "kdco-notify.json")) {
        $legacyPath = Join-Path $pkgConfigDir $legacy
        if (Test-Path -LiteralPath $legacyPath) {
            $head = ""
            try { $head = Get-Content -LiteralPath $legacyPath -TotalCount 3 -ErrorAction Stop | Out-String } catch {}
            if ($head -match "BUNDLED DEFAULT") {
                Remove-Item -LiteralPath $legacyPath -Force
                Write-Host "  removed stale bundled config: $legacyPath"
            }
        }
    }
    # Drop the package config dir if nothing remains (P6 empty slot).
    if (-not (Get-ChildItem -LiteralPath $pkgConfigDir -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $pkgConfigDir -Force
        Write-Host "  removed empty package config dir: $pkgConfigDir"
    }
}

$entryUrl = ($dest -replace "\\", "/").Replace(" ", "%20")
Write-Host ""
Write-Host "Done. Register in opencode.json(c) to enable (remove the entry to disable):"
Write-Host '  "plugin": ['
Write-Host "    [\"file:///$entryUrl/index.js\", { /* P1/P3 options */ }]"
Write-Host '  ]'
Write-Host ""
Write-Host "  package:   $dest"
Write-Host "  entry:     $dest\index.js"
Write-Host "  sample:    $dest\kdco-notify-win.sample.jsonc (inert template; copy to kdco-notify-win.jsonc to activate)"