# Validates a llama-swap config WITHOUT touching the running service: starts a second llama-swap on a spare port as a
# normal user. A broken config makes llama-swap exit immediately (code 1); a good one stays up and is stopped again.
# Always run this on a COPY before the live file is replaced or the service restarted.
#   powershell -NoProfile -File validate-config.ps1 -Config C:\llama-swap\config.yaml.new
param(
  [Parameter(Mandatory)][string]$Config,
  [string]$Exe = 'C:\llama-swap\llama-swap.exe',
  [int]$Port = 8699,          # must differ from the live port (8600)
  [int]$WaitSec = 4
)
if (-not (Test-Path $Config)) { Write-Output "NO SUCH CONFIG: $Config"; exit 2 }
if (-not (Test-Path $Exe)) { Write-Output "NO SUCH EXECUTABLE: $Exe"; exit 2 }
$out = [System.IO.Path]::GetTempFileName(); $err = [System.IO.Path]::GetTempFileName()
$p = Start-Process -FilePath $Exe -ArgumentList @('-config', $Config, '-listen', "127.0.0.1:$Port") -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds $WaitSec
if ($p.HasExited) {
  Write-Output "INVALID: llama-swap exited with code $($p.ExitCode) on this config"
  Get-Content $err, $out -ErrorAction SilentlyContinue | Where-Object { $_ } | Select-Object -First 6 | ForEach-Object { "  $_" }
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  exit 1
}
Stop-Process -Id $p.Id -Force
Remove-Item $out, $err -ErrorAction SilentlyContinue
Write-Output "OK: llama-swap started with this config on 127.0.0.1:$Port and stayed up for $WaitSec s (then stopped)"
exit 0
