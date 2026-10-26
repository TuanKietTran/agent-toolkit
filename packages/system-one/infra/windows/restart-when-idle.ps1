# Restarts the llama-swap Windows service so it loads a new config, but ONLY when no model is loaded (the owner uses a
# local GGUF model through the same service; it unloads a few minutes after the last request). Waits for QuietS
# consecutive idle seconds, then asks for elevation (UAC prompt: the user must click Yes) and runs
# restart-llama-swap-elevated.ps1, which verifies the model list and rolls back to the backup config on any failure.
#   powershell -NoProfile -File restart-when-idle.ps1 -ExpectModel system-one
# Never restarts while a model is loaded. If the service never goes idle it exits without restarting: the config on
# disk simply takes effect at the next restart.
param(
  [string]$ExpectModel = 'system-one',            # a model name that must be listed after the restart
  [string]$Service = 'llama-swap',
  [int]$Port = 8600,
  [string]$ConfigDir = 'C:\llama-swap',
  [string]$Backup = '',                           # default: newest config.yaml.bak-* in $ConfigDir
  [string]$LogDir = (Join-Path $PSScriptRoot 'logs'),
  [string]$RollbackModel = '',                    # optional: a model that must be listed again after a rollback
  [int]$QuietS = 20,
  [int]$MaxWaitMin = 25
)
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir 'restart-llama-swap.log'; Remove-Item $log -ErrorAction SilentlyContinue
if (-not $Backup) {
  $newest = Get-ChildItem $ConfigDir -Filter 'config.yaml.bak-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $newest) { Write-Output "No backup config.yaml.bak-* in ${ConfigDir}: refusing to restart without a rollback target."; return }
  $Backup = $newest.FullName
}
$base = "http://127.0.0.1:$Port"
function Running { try { @((Invoke-RestMethod "$base/running" -TimeoutSec 4).running) } catch { @('unreachable') } }
$t0 = Get-Date; $quietSince = $null
Write-Output "$(Get-Date -Format 'HH:mm:ss') waiting for llama-swap to go idle (loaded: $((Running | ForEach-Object { $_.model }) -join ','))"
while (((Get-Date) - $t0).TotalMinutes -lt $MaxWaitMin) {
  $r = Running
  if ($r.Count -eq 0) { if (-not $quietSince) { $quietSince = Get-Date }; if (((Get-Date) - $quietSince).TotalSeconds -ge $QuietS) { break } }
  else { $quietSince = $null }
  Start-Sleep 5
}
if (-not $quietSince -or ((Get-Date) - $quietSince).TotalSeconds -lt $QuietS) {
  Write-Output "$(Get-Date -Format 'HH:mm:ss') TIMEOUT: llama-swap never went idle within $MaxWaitMin min; NOT restarting. The config on disk takes effect at the next restart."
  return
}
Write-Output "$(Get-Date -Format 'HH:mm:ss') idle for $QuietS s: requesting elevation (a UAC prompt will appear; click Yes)"
$shell = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }
$helper = Join-Path $PSScriptRoot 'restart-llama-swap-elevated.ps1'
Start-Process -FilePath $shell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helper,
  '-Log', $log, '-Backup', $Backup, '-ExpectModel', $ExpectModel, '-Service', $Service, '-Port', $Port, '-ConfigDir', $ConfigDir, '-RollbackModel', $RollbackModel)
$w = Get-Date
while (((Get-Date) - $w).TotalSeconds -lt 240) { Start-Sleep 2; if ((Test-Path $log) -and (Select-String -Path $log -Pattern '^\S+ DONE' -Quiet)) { break } }
if (Test-Path $log) { Get-Content $log } else { Write-Output "no log after 4 min: the UAC prompt was probably not approved; nothing was restarted" }
Write-Output "$(Get-Date -Format 'HH:mm:ss') models on :$Port now: $(try { ((Invoke-RestMethod "$base/v1/models" -TimeoutSec 5).data.id) -join ', ' } catch { 'unreachable' })"
