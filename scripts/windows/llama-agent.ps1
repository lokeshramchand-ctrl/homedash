# llama-agent.ps1: a small control agent for llama-server on the Windows VM (set its VM id in LLAMA_VMID).
#
# The dashboard backend (on the Proxmox host, 192.168.1.17) calls it to start, stop and switch
# models. It does a fixed set of things only; it never runs arbitrary commands.
#
#   GET  /status              process, launch settings, GPU (nvidia-smi), autostart flag
#   GET  /models              *.gguf files found in $ModelDirs (vision projectors paired by folder)
#   POST /start   {json}      start llama-server (409 if running unless "restart": true)
#   POST /stop                stop every llama-server.exe
#   GET  /log?lines=200       tail of server.log
#   POST /autostart {enabled} start the last launch when the agent starts (i.e. at boot)
#   GET  /gpu                 GPU totals + per-process GPU engine use (for the mining guard, gpuwatch.ts)
#
# Every request needs  Authorization: Bearer <token from $TokenFile>  (or X-Agent-Token: <token>).
# Install with install-llama-agent.ps1 (scheduled task as SYSTEM at startup, firewall rule limited
# to the Proxmox host). Windows PowerShell 5.1 compatible.
param(
  [int]$Port = 8090,
  [string]$Root = 'C:\LlamaCPP-AI-cuda13',
  [string]$AgentDir = 'C:\LlamaCPP-AI-cuda13\agent',
  [string[]]$ModelDirs = @('C:\LlamaCPP-AI-cuda13\models', 'C:\Users\pc\.cache\huggingface\hub', 'C:\Users\pc\.llama\models'),
  [int]$LlamaPort = 8081,
  [string]$LlamaHost = '0.0.0.0'
)
$ErrorActionPreference = 'Stop'
$Version = '1.0.0'
$ServerExe = Join-Path $Root 'llama-server.exe'
$LogFile = Join-Path $Root 'server.log'
$TokenFile = Join-Path $AgentDir 'token.txt'
$LaunchFile = Join-Path $AgentDir 'last-launch.json'
$AutoFile = Join-Path $AgentDir 'autostart.json'
$AgentLog = Join-Path $AgentDir 'agent.log'

function Write-AgentLog([string]$msg) {
  try {
    if ((Test-Path $AgentLog) -and (Get-Item $AgentLog).Length -gt 2MB) { Move-Item $AgentLog "$AgentLog.1" -Force }
    Add-Content -Path $AgentLog -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg)
  } catch { }
}

$Token = (Get-Content $TokenFile -Raw).Trim()
if ($Token.Length -lt 32) { throw "Token in $TokenFile must be at least 32 characters" }

function Test-Token([string]$given) {
  if ($null -eq $given) { return $false }
  $a = [Text.Encoding]::UTF8.GetBytes($given); $b = [Text.Encoding]::UTF8.GetBytes($Token)
  $diff = $a.Length -bxor $b.Length
  for ($i = 0; $i -lt [Math]::Min($a.Length, $b.Length); $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
  return $diff -eq 0
}

# ---------- models ----------
function Get-RealSize($f) {
  # The Hugging Face cache stores snapshot files as symlinks into blobs\.
  if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    try { $t = (Get-Item -LiteralPath $f.FullName).Target; if ($t) { $p = [IO.Path]::GetFullPath((Join-Path $f.DirectoryName ([string]@($t)[0]))); return (Get-Item -LiteralPath $p).Length } } catch { }
  }
  return $f.Length
}

function Get-Id([string]$s) {
  $sha = [Security.Cryptography.SHA1]::Create()
  return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function Get-Models {
  $list = @()
  foreach ($d in $ModelDirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $files = Get-ChildItem -LiteralPath $d -Recurse -Filter *.gguf -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\blobs\\' }
    foreach ($f in $files) {
      if ($f.Name -match '^mmproj' -or $f.Name -match '-mmproj') { continue }
      if ($f.Name -match '-(\d{5})-of-(\d{5})\.gguf$' -and $Matches[1] -ne '00001') { continue }
      $size = Get-RealSize $f
      if ($f.Name -match '^(.*)-00001-of-(\d{5})\.gguf$') {
        $prefix = $Matches[1]
        $size = 0; Get-ChildItem -LiteralPath $f.DirectoryName -Filter "$prefix-*-of-*.gguf" -File | ForEach-Object { $size += Get-RealSize $_ }
      }
      $mm = Get-ChildItem -LiteralPath $f.DirectoryName -Filter *.gguf -File | Where-Object { $_.Name -match 'mmproj' } | Select-Object -First 1
      $repo = $null
      if ($f.FullName -match '\\models--([^\\]+?)--([^\\]+)\\snapshots\\') { $repo = "$($Matches[1])/$($Matches[2])" }
      $list += [ordered]@{
        id = Get-Id $f.FullName; name = [IO.Path]::GetFileNameWithoutExtension($f.Name); file = $f.Name; path = $f.FullName
        dir = $d; size = [int64]$size; modified = $f.LastWriteTimeUtc.ToString('o')
        source = $(if ($repo) { 'hf' } else { 'local' }); repo = $repo
        mmproj = $(if ($mm) { $mm.FullName } else { $null }); mmprojSize = $(if ($mm) { [int64](Get-RealSize $mm) } else { $null })
      }
    }
  }
  return $list   # unrolled on purpose: callers pipe it through Where-Object
}

# ---------- process / gpu ----------
function Get-LlamaProcs { @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue) }

function Get-Gpu {
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { $p = 'C:\Windows\System32\nvidia-smi.exe'; if (Test-Path $p) { $smi = $p } else { return $null } } else { $smi = $smi.Source }
  $gpus = @()
  try {
    $rows = & $smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit,driver_version,fan.speed,clocks.sm --format=csv,noheader,nounits 2>$null
    foreach ($r in @($rows)) {
      $c = $r -split ',\s*'
      $n = { param($v) $x = 0.0; if ([double]::TryParse($v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$x)) { $x } else { $null } }
      $gpus += [ordered]@{ name = $c[0]; memUsedMiB = (& $n $c[1]); memTotalMiB = (& $n $c[2]); util = (& $n $c[3]); tempC = (& $n $c[4]); powerW = (& $n $c[5]); powerLimitW = (& $n $c[6]); driver = $c[7]; fanPct = (& $n $c[8]); smClockMHz = (& $n $c[9]) }
    }
  } catch { }
  $apps = @()
  try {
    $rows = & $smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>$null
    foreach ($r in @($rows)) { if ($r -and $r -notmatch 'No running') { $c = $r -split ',\s*'; $m = 0; [void][int]::TryParse($c[2], [ref]$m); $apps += [ordered]@{ pid = [int]$c[0]; name = [IO.Path]::GetFileName($c[1]); memMiB = $(if ($m) { $m } else { $null }) } } }
  } catch { }
  return [ordered]@{ gpus = $gpus; apps = $apps }
}

# Shape read by gpuwatch.ts parseAgent(): { gpus: [{ name, util, memUsed, memTotal, tempC, powerW }], procs: [{ pid, name, util }] }
# memUsed/memTotal in bytes, util in percent. Per-process use comes from the "GPU Engine" counters (WDDM), summed per pid.
function Get-GpuWatch {
  $g = Get-Gpu
  $gpus = @()
  if ($g) { foreach ($x in $g.gpus) { $gpus += [ordered]@{ name = $x.name; util = $x.util; memUsed = $(if ($null -ne $x.memUsedMiB) { [int64]($x.memUsedMiB * 1MB) } else { $null }); memTotal = $(if ($null -ne $x.memTotalMiB) { [int64]($x.memTotalMiB * 1MB) } else { $null }); tempC = $x.tempC; powerW = $x.powerW } } }
  $byPid = @{}
  try {
    $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
    foreach ($c in $samples) {
      if ($c.InstanceName -match '^pid_(\d+)_' -and $c.CookedValue -gt 0) { $id = [int]$Matches[1]; $byPid[$id] = [double]($byPid[$id]) + $c.CookedValue }
    }
  } catch { }
  $procs = @()
  foreach ($k in $byPid.Keys) {
    $n = (Get-Process -Id $k -ErrorAction SilentlyContinue).ProcessName
    $procs += [ordered]@{ pid = $k; name = $(if ($n) { "$n.exe" } else { "pid $k" }); util = [Math]::Min(100, [Math]::Round($byPid[$k], 1)) }
  }
  return [ordered]@{ gpus = $gpus; procs = @($procs | Sort-Object { $_.util } -Descending | Select-Object -First 15) }
}

function Read-Json([string]$path) { if (Test-Path $path) { try { return Get-Content $path -Raw | ConvertFrom-Json } catch { } } return $null }

function Get-Status {
  $procs = Get-LlamaProcs
  $p = $procs | Select-Object -First 1
  $proc = $null
  if ($p) {
    $started = $null; try { $started = $p.CreationDate.ToUniversalTime().ToString('o') } catch { }
    $proc = [ordered]@{ pid = [int]$p.ProcessId; started = $started; ramBytes = [int64]$p.WorkingSetSize; commandLine = $p.CommandLine; count = $procs.Count }
  }
  $listen = $null
  try { $c = Get-NetTCPConnection -LocalPort $LlamaPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $listen = [ordered]@{ pid = [int]$c.OwningProcess; name = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName } } } catch { }
  $os = Get-CimInstance Win32_OperatingSystem
  $auto = Read-Json $AutoFile
  return [ordered]@{
    agent = $Version; host = $env:COMPUTERNAME; time = (Get-Date).ToUniversalTime().ToString('o')
    bootTime = $os.LastBootUpTime.ToUniversalTime().ToString('o')
    ramFreeBytes = [int64]$os.FreePhysicalMemory * 1024; ramTotalBytes = [int64]$os.TotalVisibleMemorySize * 1024
    serverExe = $ServerExe; serverExists = (Test-Path $ServerExe); port = $LlamaPort
    process = $proc; portOwner = $listen
    launch = (Read-Json $LaunchFile); autostart = [bool]($auto -and $auto.enabled)
    gpu = (Get-Gpu)
  }
}

# ---------- start / stop ----------
$CacheTypes = @('f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1')
# Flags the dashboard may not pass as "extra": they change where the server listens, what files it reads or writes, or its auth.
$Forbidden = '^(--host|--port|--path|--log-file|--api-key|--api-key-file|--ssl-key-file|--ssl-cert-file|-m|--model|-mu|--model-url|--mmproj|--mmproj-url|-hf|-hfr|-hff|-hft|-hfv|--hf-[a-z-]+|--lora|--lora-scaled|--control-vector[a-z-]*|--grammar-file|-mm|--slot-save-path|--chat-template-file|--models-dir|--models-preset|-o|--output)(=|$)'

function Quote-Arg([string]$a) { if ($a -match '[\s"]') { return '"' + ($a -replace '"', '\"') + '"' } return $a }

function Build-Args($o, $model) {
  $argv = @('-m', $model.path, '--host', $LlamaHost, '--port', "$LlamaPort", '--metrics', '--slots', '--log-file', $LogFile)
  $int = { param($v, $lo, $hi, $name) if ($null -eq $v) { return $null }; $x = 0; if (-not [int]::TryParse("$v", [ref]$x) -or $x -lt $lo -or $x -gt $hi) { throw "bad $name" }; return $x }
  $ngl = & $int $o.ngl 0 999 'ngl'; if ($null -ne $ngl) { $argv += @('-ngl', "$ngl") } else { $argv += @('-ngl', '99') }
  $ctx = & $int $o.ctx 0 1048576 'ctx'; if ($null -ne $ctx -and $ctx -gt 0) { $argv += @('-c', "$ctx") }
  $np = & $int $o.parallel 1 64 'parallel'; if ($null -ne $np) { $argv += @('-np', "$np") }
  $th = & $int $o.threads 1 256 'threads'; if ($null -ne $th) { $argv += @('-t', "$th") }
  $bs = & $int $o.batch 32 65536 'batch'; if ($null -ne $bs) { $argv += @('-b', "$bs") }
  $ub = & $int $o.ubatch 32 65536 'ubatch'; if ($null -ne $ub) { $argv += @('-ub', "$ub") }
  if ($o.flashAttn) { if (@('on', 'off', 'auto') -notcontains "$($o.flashAttn)") { throw 'bad flashAttn' }; $argv += @('-fa', "$($o.flashAttn)") }
  if ($o.cacheK) { if ($CacheTypes -notcontains "$($o.cacheK)") { throw 'bad cacheK' }; $argv += @('-ctk', "$($o.cacheK)") }
  if ($o.cacheV) { if ($CacheTypes -notcontains "$($o.cacheV)") { throw 'bad cacheV' }; $argv += @('-ctv', "$($o.cacheV)") }
  if ($o.alias) { if ("$($o.alias)" -notmatch '^[A-Za-z0-9._:-]{1,64}$') { throw 'bad alias' }; $argv += @('--alias', "$($o.alias)") }
  if ($o.vision -and $model.mmproj) { $argv += @('--mmproj', $model.mmproj) }
  if ($o.noMmap) { $argv += '--no-mmap' }
  if ($o.jinja) { $argv += '--jinja' }
  foreach ($e in @($o.extra)) {
    if ($null -eq $e -or "$e" -eq '') { continue }
    $s = "$e"
    if ($s -notmatch '^[A-Za-z0-9._:=,+-]{1,128}$') { throw "extra argument not allowed: $s" }
    if ($s -match $Forbidden) { throw "extra argument not allowed: $s" }
    $argv += $s
  }
  return ,$argv
}

function Stop-Llama {
  $procs = Get-LlamaProcs
  foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
  for ($i = 0; $i -lt 30; $i++) { if ((Get-LlamaProcs).Count -eq 0) { break }; Start-Sleep -Milliseconds 500 }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort $LlamaPort -State Listen -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }
  return $procs.Count
}

function Start-Llama($o) {
  if (-not (Test-Path $ServerExe)) { return @(500, @{ error = "$ServerExe not found"; code = 'NO_SERVER' }) }
  $model = @(Get-Models) | Where-Object { $_.id -eq "$($o.modelId)" } | Select-Object -First 1
  if (-not $model) { return @(404, @{ error = 'Unknown model id (not found in the model folders)'; code = 'NO_MODEL' }) }
  try { $argv = Build-Args $o $model } catch { return @(400, @{ error = $_.Exception.Message; code = 'BAD_ARGS' }) }
  if ((Get-LlamaProcs).Count -gt 0) {
    if (-not $o.restart) { return @(409, @{ error = 'llama-server is already running'; code = 'ALREADY_RUNNING' }) }
    [void](Stop-Llama)
  }
  if (Get-NetTCPConnection -LocalPort $LlamaPort -State Listen -ErrorAction SilentlyContinue) { return @(409, @{ error = "Port $LlamaPort is held by another program"; code = 'PORT_IN_USE' }) }
  if (Test-Path $LogFile) { try { Move-Item $LogFile "$LogFile.prev" -Force } catch { } }
  $cmd = (@($ServerExe) + $argv | ForEach-Object { Quote-Arg $_ }) -join ' '
  # Win32_Process.Create: the server is not a child of this agent, so restarting the agent task leaves it running.
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $Root }
  if ($r.ReturnValue -ne 0) { return @(500, @{ error = "Win32_Process.Create failed ($($r.ReturnValue))"; code = 'START_FAILED' }) }
  $launch = [ordered]@{ modelId = $model.id; modelName = $model.name; modelPath = $model.path; settings = $o; args = $argv; commandLine = $cmd; pid = [int]$r.ProcessId; started = (Get-Date).ToUniversalTime().ToString('o') }
  ($launch | ConvertTo-Json -Depth 6) | Set-Content -Path $LaunchFile -Encoding UTF8
  Write-AgentLog "start pid=$($r.ProcessId) $cmd"
  return @(202, $launch)
}

function Read-Tail([string]$path, [int]$lines) {
  if (-not (Test-Path $path)) { return @() }
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $len = $fs.Length; $take = [Math]::Min($len, 512KB); [void]$fs.Seek($len - $take, 'Begin')
    $buf = New-Object byte[] $take; [void]$fs.Read($buf, 0, $take)
    $all = [Text.Encoding]::UTF8.GetString($buf) -split "`r?`n"
    if ($take -lt $len -and $all.Count -gt 0) { $all = $all[1..($all.Count - 1)] }
    $all = @($all | Where-Object { $_ -ne '' })
    if ($all.Count -eq 0) { return @() }
    return $all[[Math]::Max(0, $all.Count - $lines)..($all.Count - 1)]
  } finally { $fs.Dispose() }
}

# ---------- http ----------
function Send($ctx, [int]$status, $obj) {
  $json = if ($obj -is [string]) { $obj } else { $obj | ConvertTo-Json -Depth 8 -Compress }
  $b = [Text.Encoding]::UTF8.GetBytes($json)
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.Headers['Cache-Control'] = 'no-store'
  $ctx.Response.ContentLength64 = $b.Length
  $ctx.Response.OutputStream.Write($b, 0, $b.Length)
  $ctx.Response.Close()
}

function Read-Body($req) {
  if (-not $req.HasEntityBody) { return [pscustomobject]@{} }
  if ($req.ContentLength64 -gt 64KB) { throw 'body too large' }
  $sr = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
  $t = $sr.ReadToEnd(); if (-not $t.Trim()) { return [pscustomobject]@{} }
  return $t | ConvertFrom-Json
}

# Autostart: relaunch the last settings when the agent starts (normally at boot).
$auto = Read-Json $AutoFile; $last = Read-Json $LaunchFile
if ($auto -and $auto.enabled -and $last -and $last.settings -and (Get-LlamaProcs).Count -eq 0) {
  try { $r = Start-Llama $last.settings; Write-AgentLog "autostart -> $($r[0])" } catch { Write-AgentLog "autostart failed: $($_.Exception.Message)" }
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()
Write-AgentLog "agent $Version listening on :$Port"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $path = $req.Url.AbsolutePath.TrimEnd('/'); if ($path -eq '') { $path = '/' }
  $m = $req.HttpMethod
  try {
    $given = $req.Headers['X-Agent-Token']
    $auth = $req.Headers['Authorization']; if (-not $given -and $auth -and $auth.StartsWith('Bearer ')) { $given = $auth.Substring(7).Trim() }
    if (-not (Test-Token $given)) { Write-AgentLog "401 $m $path from $($req.RemoteEndPoint)"; Send $ctx 401 @{ error = 'Bad or missing agent token'; code = 'UNAUTHORIZED' }; continue }
    switch ("$m $path") {
      'GET /status' { Send $ctx 200 (Get-Status) }
      'GET /gpu' { Send $ctx 200 (Get-GpuWatch) }
      'GET /models' { Send $ctx 200 @{ dirs = $ModelDirs; models = @(Get-Models) } }
      'GET /log' {
        $n = 200; [void][int]::TryParse($req.QueryString['lines'], [ref]$n); $n = [Math]::Min([Math]::Max($n, 1), 2000)
        $f = if ($req.QueryString['prev'] -eq '1') { "$LogFile.prev" } else { $LogFile }
        Send $ctx 200 @{ file = $f; lines = @(Read-Tail $f $n) }
      }
      'POST /start' { $r = Start-Llama (Read-Body $req); Send $ctx $r[0] $r[1] }
      'POST /stop' { $n = Stop-Llama; Write-AgentLog "stop ($n processes)"; Send $ctx 200 @{ stopped = $n } }
      'POST /autostart' {
        $b = Read-Body $req; $en = [bool]$b.enabled
        (@{ enabled = $en } | ConvertTo-Json) | Set-Content -Path $AutoFile -Encoding UTF8
        Write-AgentLog "autostart=$en"; Send $ctx 200 @{ autostart = $en }
      }
      default { Send $ctx 404 @{ error = "No route $m $path"; code = 'NOT_FOUND' } }
    }
  } catch {
    Write-AgentLog "500 $m $path $($_.Exception.Message)"
    try { Send $ctx 500 @{ error = $_.Exception.Message; code = 'AGENT_ERROR' } } catch { }
  }
}
