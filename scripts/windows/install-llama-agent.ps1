# install-llama-agent.ps1: one-time setup of the llama control agent on the Windows VM.
# Run in an elevated PowerShell (Run as Administrator), from the folder that holds llama-agent.ps1:
#     powershell -ExecutionPolicy Bypass -File .\install-llama-agent.ps1
# Safe to run again (it updates the script, keeps the token, re-registers the task).
param(
  [string]$Root = 'C:\LlamaCPP-AI-cuda13',
  [int]$Port = 8090,
  [string]$DashboardHost = '192.168.1.17'   # the Proxmox host; the only machine allowed to reach the agent
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an elevated PowerShell (Run as Administrator).' }

$agentDir = Join-Path $Root 'agent'
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'llama-agent.ps1') -Destination (Join-Path $agentDir 'llama-agent.ps1') -Force

# Token: 48 random bytes, created once. Only SYSTEM and Administrators can read the agent folder.
$tokenFile = Join-Path $agentDir 'token.txt'
if (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $tok = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  Set-Content -Path $tokenFile -Value $tok -NoNewline -Encoding ASCII
}
& icacls $agentDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

# Firewall: agent port only from the dashboard host.
Get-NetFirewallRule -DisplayName 'llama-agent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'llama-agent' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $DashboardHost -Action Allow -Profile Any | Out-Null

# Scheduled task: starts at boot as SYSTEM, restarts if it dies, no time limit.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agentDir\llama-agent.ps1`" -Port $Port -Root `"$Root`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$task = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Stop-ScheduledTask -TaskName 'LlamaAgent' -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'LlamaAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $task -Force | Out-Null
Start-ScheduledTask -TaskName 'LlamaAgent'
Start-Sleep -Seconds 3

$tok = (Get-Content $tokenFile -Raw).Trim()
try {
  $s = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 15
  Write-Host "Agent $($s.agent) is running on port $Port (host $($s.host))." -ForegroundColor Green
} catch {
  Write-Warning "The agent did not answer yet: $($_.Exception.Message). Check $agentDir\agent.log"
}
Write-Host ''
Write-Host 'Put these two lines in the dashboard server .env (/root/web-host/app/server/.env):'
Write-Host "  LLAMA_AGENT_URL=http://$((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.1.*' } | Select-Object -First 1).IPAddress):$Port"
Write-Host "  LLAMA_AGENT_TOKEN=$tok"
