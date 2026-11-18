# 開機時用指定的 Chrome 帳號（設定檔）開啟 Chrome，讓「Google Play 每週獎勵自動領取」擴充功能在那個帳號裡執行。
# 本週每週獎勵已經處理完的話，開機就不開 Chrome。平常透過同資料夾的 .bat 執行，不用直接跑這支。
#
#   open_chrome.ps1             立刻用指定帳號開 Chrome
#   open_chrome.ps1 -List       列出這台電腦所有 Chrome 帳號，可直接輸入編號寫進 設定.txt
#   open_chrome.ps1 -Startup    開機用：先等「延遲秒數」，再判斷要不要開；失敗會跳提示並寫進 啟動紀錄.log
#   open_chrome.ps1 -Install    在 Windows「啟動」資料夾建捷徑，之後每次登入 Windows 自動執行 -Startup
#   open_chrome.ps1 -Uninstall  移除上面那個捷徑
#   open_chrome.ps1 -Check      只顯示狀態和「現在開機會不會開 Chrome」，不開 Chrome
#   加上 -DryRun                只顯示會執行的指令，不真的開 Chrome（除錯用）
#
# 狀態檔：擴充功能（v1.1+）寫在 Chrome 下載資料夾的 Chrome插件狀態\google_play_weekly.json
#   {"week":"最近一個週五 YYYY-MM-DD","allDone":true/false,...}；week 是本週而且 allDone = 本週處理完
#
# 開機（-Startup）時不開 Chrome 的兩種情況：
#   1. 同一個 Chrome 帳號已經開著（例如另一個插件的開機腳本剛開過）
#   2. 設定.txt「已完成就不開=是」（預設），而且上面那個狀態檔顯示已經完成
#
# 注意：這個檔案必須存成「UTF-8 含 BOM」，否則 Windows PowerShell 5.1 讀中文會變亂碼。

param(
  [switch]$List,
  [switch]$Startup,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Check,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ScriptPath   = $MyInvocation.MyCommand.Path
$Here         = Split-Path -Parent $ScriptPath
$ConfigPath   = Join-Path $Here '設定.txt'
$LogPath      = Join-Path $Here '啟動紀錄.log'
$ShortcutName = 'GooglePlay每週獎勵_開啟Chrome.lnk'
$Title        = 'Google Play 每週獎勵'

# ---------- 小工具 ----------

function Write-Log([string]$msg) {
  Write-Host $msg
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    $old = @()
    if (Test-Path -LiteralPath $LogPath) {
      $old = @(Get-Content -LiteralPath $LogPath -Encoding UTF8 | Select-Object -Last 199)
    }
    Set-Content -LiteralPath $LogPath -Value ($old + $line) -Encoding UTF8
  } catch {}
}

# 讀文字檔：先當 UTF-8，不是的話當系統預設編碼（Big5），避免使用者用別的編碼存檔就壞掉
function Read-TextFile([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  try {
    $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
  } catch {
    $text = [Text.Encoding]::Default.GetString($bytes)
  }
  return $text.TrimStart([char]0xFEFF)
}

# 同時支援 ConvertFrom-Json 的物件和 JavaScriptSerializer 的 Dictionary
function Get-Child($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return $obj[$name] }
    return $null
  }
  $p = $obj.PSObject.Properties[$name]
  if ($p) { return $p.Value }
  return $null
}

function Get-Keys($obj) {
  if ($null -eq $obj) { return @() }
  if ($obj -is [System.Collections.IDictionary]) { return @($obj.Keys) }
  return @($obj.PSObject.Properties | ForEach-Object { $_.Name })
}

# ---------- 設定 ----------

function Read-Config {
  $cfg = @{ '帳號' = ''; '視窗' = 'normal'; '延遲秒數' = '20'; 'Chrome資料夾' = ''; 'Chrome路徑' = ''; '已完成就不開' = '是' }
  if (Test-Path -LiteralPath $ConfigPath) {
    foreach ($line in ((Read-TextFile $ConfigPath) -split "`r?`n")) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
  }
  return $cfg
}

# 把「帳號=」那一行換成新的值，其他行原樣保留
function Save-Account([string]$value) {
  $lines = @()
  if (Test-Path -LiteralPath $ConfigPath) { $lines = @((Read-TextFile $ConfigPath) -split "`r?`n") }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*帳號\s*=') { $lines[$i] = '帳號=' + $value; $found = $true }
  }
  if (-not $found) { $lines += ('帳號=' + $value) }
  while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
  Set-Content -LiteralPath $ConfigPath -Value $lines -Encoding UTF8
}

# ---------- Chrome ----------

function Get-UserDataDir($cfg) {
  if ($cfg['Chrome資料夾']) { return $cfg['Chrome資料夾'].Trim('"') }
  return (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
}

function Find-Chrome($cfg) {
  $cands = @()
  if ($cfg['Chrome路徑']) { $cands += $cfg['Chrome路徑'] }
  foreach ($root in 'HKCU:', 'HKLM:') {
    try {
      $p = (Get-ItemProperty -Path "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction Stop).'(default)'
      if ($p) { $cands += $p }
    } catch {}
  }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if ($base) { $cands += (Join-Path $base 'Google\Chrome\Application\chrome.exe') }
  }
  foreach ($c in $cands) {
    $c = $c.Trim().Trim('"')
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  throw '找不到 chrome.exe。請在 設定.txt 的「Chrome路徑=」填上完整路徑。'
}

# 從 Chrome 的「Local State」讀出所有帳號（設定檔）
function Get-Profiles([string]$dataDir) {
  $statePath = Join-Path $dataDir 'Local State'
  if (-not (Test-Path -LiteralPath $statePath)) {
    throw "找不到 Chrome 的帳號清單：$statePath`n這台電腦可能沒裝 Chrome，或資料放在別處（可在 設定.txt 的「Chrome資料夾=」指定）。"
  }
  $raw = Read-TextFile $statePath
  try {
    $json = $raw | ConvertFrom-Json
  } catch {
    # Windows PowerShell 5.1 遇到只差大小寫的重複 key 會失敗，改用 .NET 的解析器
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $json = $ser.DeserializeObject($raw)
  }
  $cache = Get-Child (Get-Child $json 'profile') 'info_cache'
  if ($null -eq $cache) { throw 'Chrome 的 Local State 裡找不到帳號清單（profile.info_cache）。' }

  $list = @()
  foreach ($dir in (Get-Keys $cache)) {
    $info = Get-Child $cache $dir
    $list += [pscustomobject]@{
      Dir   = [string]$dir
      Name  = [string](Get-Child $info 'name')
      Email = [string](Get-Child $info 'user_name')
      Gaia  = [string](Get-Child $info 'gaia_name')
    }
  }
  # Default 排第一，其餘照 Profile 編號
  return @($list | Sort-Object @{ Expression = { if ($_.Dir -eq 'Default') { -1 } elseif ($_.Dir -match '(\d+)$') { [int]$Matches[1] } else { 9999 } } })
}

# 依序用 Gmail → 資料夾名稱 → 顯示名稱 → Google 名字 比對，不分大小寫
function Find-Profile($profiles, [string]$want) {
  $w = $want.Trim()
  foreach ($key in 'Email', 'Dir', 'Name', 'Gaia') {
    $hit = @($profiles | Where-Object { $v = $_.$key; $v -and ($v.Trim() -ieq $w) })
    if ($hit.Count -eq 1) { return $hit[0] }
    if ($hit.Count -gt 1) { throw "有 $($hit.Count) 個帳號的名稱都是「$w」，請改填 Gmail 或資料夾名稱。" }
  }
  return $null
}

function Resolve-Target($cfg) {
  $want = $cfg['帳號']
  if (-not $want) { throw '設定.txt 的「帳號=」還沒填。先執行「1_列出Chrome帳號並選擇.bat」選一個。' }
  $dataDir  = Get-UserDataDir $cfg
  $profiles = @(Get-Profiles $dataDir)
  $p = Find-Profile $profiles $want
  if ($null -eq $p) { throw "找不到帳號「$want」。執行「1_列出Chrome帳號並選擇.bat」看看有哪些。" }
  return @{ Profile = $p; DataDir = $dataDir }
}

function Open-Chrome($cfg) {
  $t = Resolve-Target $cfg
  $p = $t.Profile
  $chrome = Find-Chrome $cfg

  $chromeArgs = @('--profile-directory="' + $p.Dir + '"')
  if ($cfg['Chrome資料夾']) { $chromeArgs += ('--user-data-dir="' + $t.DataDir + '"') }
  $style = 'Normal'
  if ($cfg['視窗'] -match '^\s*(min|縮小)') { $style = 'Minimized' }

  if ($DryRun) {
    Write-Host ('[DryRun] "{0}" {1}   視窗：{2}' -f $chrome, ($chromeArgs -join ' '), $style)
    return
  }
  Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle $style
  Write-Log ('已用「{0}」（{1}）開啟 Chrome' -f (Format-Profile $p), $p.Dir)
}

function Format-Profile($p) {
  if ($p.Email) { return '{0} / {1}' -f $p.Name, $p.Email }
  return $p.Name
}

# ---------- 插件狀態檔（判斷開機要不要開 Chrome） ----------

function Read-Json([string]$path) {
  $raw = Read-TextFile $path
  try { return ($raw | ConvertFrom-Json) } catch {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    return $ser.DeserializeObject($raw)
  }
}

# Chrome 這個設定檔的下載資料夾（Preferences 的 download.default_directory），讀不到就用系統的「下載」
function Get-DownloadDir($t) {
  try {
    $prefs = Join-Path (Join-Path $t.DataDir $t.Profile.Dir) 'Preferences'
    if (Test-Path -LiteralPath $prefs) {
      $dir = [string](Get-Child (Get-Child (Read-Json $prefs) 'download') 'default_directory')
      if ($dir -and (Test-Path -LiteralPath $dir)) { return $dir }
    }
  } catch {}
  try {
    $p = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  } catch {}
  return (Join-Path $env:USERPROFILE 'Downloads')
}

# 最近一個週五（含今天）的日期，跟 Google Play 插件的「本週」算法一樣
function Get-WeekKey {
  $d = (Get-Date).Date
  $back = ([int]$d.DayOfWeek - 5 + 7) % 7
  return $d.AddDays(-$back).ToString('yyyy-MM-dd')
}

# 同一個 Chrome 帳號（設定檔）是不是已經開著（例如另一個插件的開機腳本剛開過）。開機時已經開著就不再開一次，免得多一個視窗。
# 只認得「用 --profile-directory 開的」Chrome；平常手動點開的 Chrome 命令列沒有這個參數，無法確定是哪個帳號，當成沒開。
function Test-ProfileRunning($t) {
  try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
    $a = '--profile-directory="' + $t.Profile.Dir + '"'
    $b = '--profile-directory=' + $t.Profile.Dir
    foreach ($p in $procs) {
      $cl = [string]$p.CommandLine
      if (-not $cl -or $cl -match '--type=') { continue }   # 只看主程式，不看分頁／外掛的子程序
      if ($cl.IndexOf($a, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
      if ($cl -match ('(^|\s)' + [regex]::Escape($b) + '(\s|$)')) { return $true }
    }
  } catch {}
  return $false
}

# 回傳 @{ Done = 本週處理完了沒; Lines = 說明文字陣列 }
function Get-PluginStatus($cfg) {
  $t = Resolve-Target $cfg
  $dir = Join-Path (Get-DownloadDir $t) 'Chrome插件狀態'
  $lines = @("狀態檔資料夾：$dir")
  $wk = Get-WeekKey
  $gp = Join-Path $dir 'google_play_weekly.json'
  if (-not (Test-Path -LiteralPath $gp)) {
    $lines += 'Google Play：還沒有狀態檔（擴充功能要 v1.1 以上；在 chrome://extensions 重新載入一次就會產生）'
    return @{ Done = $false; Lines = $lines }
  }
  $j = Read-Json $gp
  $week = [string](Get-Child $j 'week')
  $all = [bool](Get-Child $j 'allDone')
  if ($week -eq $wk -and $all) {
    $lines += "Google Play：本週（$wk 週五起）每週獎勵已處理完"
    return @{ Done = $true; Lines = $lines }
  }
  if ($week -ne $wk) { $lines += "Google Play：本週（$wk 週五起）還沒檢查" }
  else { $lines += ('Google Play：本週還有 {0} 個帳號沒處理完' -f (Get-Child $j 'pending')) }
  return @{ Done = $false; Lines = $lines }
}

# ---------- 各模式 ----------

function Show-List($cfg) {
  $profiles = @(Get-Profiles (Get-UserDataDir $cfg))
  Write-Host ''
  Write-Host '這台電腦上的 Chrome 帳號：'
  Write-Host ''
  for ($i = 0; $i -lt $profiles.Count; $i++) {
    $p = $profiles[$i]
    $email = if ($p.Email) { $p.Email } else { '（沒有登入 Google）' }
    Write-Host ('  [{0}] {1}' -f ($i + 1), $p.Name)
    Write-Host ('      Gmail：{0}' -f $email)
    Write-Host ('      資料夾：{0}' -f $p.Dir)
    Write-Host ''
  }
  if ($cfg['帳號']) {
    $cur = Find-Profile $profiles $cfg['帳號']
    if ($cur) { Write-Host ('目前設定：{0}' -f (Format-Profile $cur)) }
    else { Write-Host ('目前設定的「{0}」找不到對應的帳號。' -f $cfg['帳號']) }
    Write-Host ''
  }

  $ans = Read-Host '輸入編號把它設成要開的帳號（直接按 Enter 不改）'
  $n = 0
  if ([int]::TryParse(($ans + '').Trim(), [ref]$n) -and $n -ge 1 -and $n -le $profiles.Count) {
    $p = $profiles[$n - 1]
    # 有 Gmail 用 Gmail（看得懂、也不會因為改名失效），沒有就用資料夾名稱
    $value = if ($p.Email) { $p.Email } else { $p.Dir }
    Save-Account $value
    Write-Host ('已寫進 設定.txt：帳號={0}' -f $value)
  } elseif (($ans + '').Trim() -ne '') {
    Write-Host '編號不對，沒有修改。'
  }
}

function Install-Startup($cfg) {
  # 先確認設定是對的，免得裝了開機才發現開不起來
  $t = Resolve-Target $cfg
  $null = Find-Chrome $cfg

  $startupDir = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startupDir $ShortcutName
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '" -Startup'
  $sc.WorkingDirectory = $Here
  $sc.WindowStyle = 7
  $sc.Description = 'Google Play 每週獎勵：登入 Windows 後，本週還沒領完才用指定帳號開 Chrome'
  $sc.Save()

  Write-Log ('已設定開機自動開啟：{0}' -f (Format-Profile $t.Profile))
  Write-Host ('捷徑位置：{0}' -f $lnk)
  Write-Host '（這個資料夾之後如果搬家，要重新執行一次安裝。）'
}

function Uninstall-Startup {
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) $ShortcutName
  if (Test-Path -LiteralPath $lnk) {
    Remove-Item -LiteralPath $lnk
    Write-Log '已移除開機自動開啟。'
  } else {
    Write-Host '本來就沒有設定開機自動開啟。'
  }
}

# ---------- 主程式 ----------

try {
  $cfg = Read-Config
  if ($List) {
    Show-List $cfg
  } elseif ($Install) {
    Install-Startup $cfg
  } elseif ($Uninstall) {
    Uninstall-Startup
  } elseif ($Check) {
    $st = Get-PluginStatus $cfg
    $st.Lines | ForEach-Object { Write-Host $_ }
    Write-Host ''
    if ($cfg['已完成就不開'] -match '^\s*(否|no|false|0)') { Write-Host '設定.txt「已完成就不開=否」：開機一律開 Chrome' }
    elseif ($st.Done) { Write-Host '→ 現在開機的話：本週已處理完，不會開 Chrome' }
    else { Write-Host '→ 現在開機的話：本週還沒處理完，會開 Chrome' }
  } else {
    if ($Startup) {
      $sec = 0
      [void][int]::TryParse([string]$cfg['延遲秒數'], [ref]$sec)
      if ($sec -gt 0) { Start-Sleep -Seconds $sec }
      $t0 = $null
      try { $t0 = Resolve-Target $cfg } catch {}
      if ($t0 -and (Test-ProfileRunning $t0)) {
        Write-Log ('Chrome（{0}）已經開著，不再開一次' -f (Format-Profile $t0.Profile))
        exit 0
      }
      if ($cfg['已完成就不開'] -notmatch '^\s*(否|no|false|0)') {
        $st = $null
        try { $st = Get-PluginStatus $cfg } catch { Write-Log ('讀插件狀態失敗，照常開 Chrome：' + $_.Exception.Message) }
        if ($st -and $st.Done) {
          Write-Log ('已經完成，不開 Chrome（' + (($st.Lines | Select-Object -Skip 1) -join '；') + '）')
          exit 0
        }
      }
    }
    Open-Chrome $cfg
  }
} catch {
  $msg = $_.Exception.Message
  Write-Log ('失敗：' + $msg)
  if ($Startup) {
    # 開機時視窗是隱藏的，用一個 60 秒後自動關掉的提示框告訴使用者
    try { $null = (New-Object -ComObject WScript.Shell).Popup("開機自動開啟 Chrome 失敗：`n`n$msg", 60, $Title, 48) } catch {}
  }
  exit 1
}
