# Installs a Windows Startup shortcut so Internship Pilot launches
# automatically when you log in. Safe to re-run (overwrites the shortcut).
# To undo: npm run startup:uninstall
$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$startupFolder = [Environment]::GetFolderPath("Startup")
$cmdPath = Join-Path $projectDir "scripts\run-on-startup.cmd"
$shortcutPath = Join-Path $startupFolder "Internship Pilot.lnk"

$cmdContent = @"
@echo off
cd /d "$projectDir"
echo Starting Internship Pilot (this window shows live scheduler activity)...
npm run dev
"@
Set-Content -Path $cmdPath -Value $cmdContent -Encoding ASCII

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $cmdPath
$shortcut.WorkingDirectory = $projectDir
$shortcut.WindowStyle = 1
$shortcut.Description = "Internship Pilot - launches automatically with Windows"
$shortcut.Save()

Write-Host "Installed. Internship Pilot will launch automatically the next time you log into Windows."
Write-Host "Shortcut: $shortcutPath"
Write-Host "To undo this: npm run startup:uninstall"
