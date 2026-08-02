$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "Internship Pilot.lnk"

if (Test-Path $shortcutPath) {
  Remove-Item $shortcutPath -Force
  Write-Host "Removed the Windows startup entry for Internship Pilot."
} else {
  Write-Host "No Internship Pilot startup entry was found (nothing to remove)."
}
