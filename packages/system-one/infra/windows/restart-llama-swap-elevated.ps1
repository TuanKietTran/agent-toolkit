# Runs ELEVATED (started through UAC by restart-when-idle.ps1; do not run by hand unless you know why).
# Restarts the llama-swap service so it loads the new config, verifies that -ExpectModel is listed, and rolls back to
# -Backup (restart again) if anything is wrong. Writes a line-by-line log to -Log; the last line is "DONE <ok|aborted|rolledback|error>".
param(
  [Parameter(Mandatory)][string]$Log,
  [Parameter(Mandatory)][string]$Backup,
  [string]$ExpectModel = 'system-one',
  [string]$Service = 'llama-swap',
  [int]$Port = 8600,
  [string]$ConfigDir = 'C:\llama-swap',
  [string]$RollbackModel = ''
)
function L($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Add-Content -Path $Log -Encoding utf8 }
$base = "http://127.0.0.1:$Port"
function Models { try { ((Invoke-RestMethod "$base/v1/models" -TimeoutSec 4).data.id) -join ',' } catch { '' } }
$cfg = Join-Path $ConfigDir 'config.yaml'
try {
  L "elevated helper started; backup=$Backup"
  $r = (Invoke-RestMethod "$base/running" -TimeoutSec 4).running
  if ($r) { L "ABORT: models are loaded again ($(($r | ForEach-Object { $_.model }) -join ',')); not restarting"; L 'DONE aborted'; return }
  Restart-Service -Name $Service -Force -ErrorAction Stop
  L 'Restart-Service issued'
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep 1; if ((Models) -match [regex]::Escape($ExpectModel)) { $ok = $true; break } }
  $svc = (Get-Service $Service).Status
  if ($ok) { L "OK service=$svc models=$(Models)"; L 'DONE ok' }
  else {
    L "FAILED: $ExpectModel not listed after restart (service=$svc models=$(Models)); ROLLING BACK to $Backup"
    Copy-Item -Path $Backup -Destination $cfg -Force
    Restart-Service -Name $Service -Force
    $back = $false
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep 1; $m = Models; if ($m -and (-not $RollbackModel -or $m -match [regex]::Escape($RollbackModel))) { $back = $true; break } }
    L "rollback finished: service=$((Get-Service $Service).Status) restored=$back models=$(Models)"; L 'DONE rolledback'
  }
} catch {
  L "ERROR: $($_.Exception.Message)"
  try { Copy-Item -Path $Backup -Destination $cfg -Force; Restart-Service -Name $Service -Force; L 'config restored and service restarted after error' }
  catch { L "rollback ALSO failed: $($_.Exception.Message)" }
  L 'DONE error'
}
