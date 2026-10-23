/**
 * The text of the two PowerShell scripts this plugin runs, plus the one
 * judgement that decides whether running them makes sense here.
 *
 * Kept apart from the plugin entry so the invariants can be tested without a
 * Host: everything below is a pure function of its arguments and of
 * `process` — no `ctx`, no I/O.
 */
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'

/** Quote one PowerShell single-quoted literal. */
export function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Whether this Host can restart the application it belongs to.
 * @returns a fact record; `ok: false` carries the reason the button is hidden.
 */
export function desktopFacts() {
  if (process.platform !== 'win32') return { ok: false, reason: '仅支持 Windows 桌面版' }
  // The desktop Host may run inside the Electron main process, inside a
  // utility process, or as a `ELECTRON_RUN_AS_NODE` child; only the first case
  // lacks the env flag, so accept either signal as "this is Electron".
  const inElectron = typeof process.versions.electron === 'string' || process.env.ELECTRON_RUN_AS_NODE === '1'
  if (!inElectron) return { ok: false, reason: '当前不是桌面应用的宿主进程' }
  const executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath
  if (typeof executable !== 'string' || !executable.toLowerCase().endsWith('.exe')) {
    return { ok: false, reason: '找不到桌面应用的可执行文件' }
  }
  // `ELECTRON_RUN_AS_NODE` reaches every child of the shell, including a `dsh
  // web` a user starts from the app's own terminal; that Host must not offer to
  // stop and relaunch a bare `node.exe`, so the executable itself has to be the
  // application's.
  if (basename(executable).toLowerCase() === 'node.exe') {
    return { ok: false, reason: '当前是独立的 node 宿主，不是桌面应用' }
  }
  if (!existsSync(executable)) return { ok: false, reason: '桌面应用可执行文件不存在' }
  if (!Number.isInteger(process.ppid) || process.ppid <= 4) {
    return { ok: false, reason: '找不到桌面应用的主进程' }
  }
  return {
    ok: true,
    executable,
    processName: basename(executable, '.exe'),
    applicationDirectory: dirname(executable),
  }
}

/**
 * restart.ps1 — the helper that outlives the application.
 * Written as lines (not one template literal) so PowerShell and JavaScript
 * quoting stay apart; no backticks and no `${` appear in the output.
 *
 * The helper inherits the application's environment: this Host was started by
 * the shell with exactly that environment plus `ELECTRON_RUN_AS_NODE`, and a
 * child process inherits it in turn. So the only environment work here is
 * deleting the shell's markers — nothing is read back from a file. A JSON round
 * trip is what broke the first version: PowerShell 5.1 decodes a BOM-less file
 * as the ANSI code page, a Chinese directory in `PATH` turns into mojibake, the
 * trailing byte of a mangled character swallows the `\` of the next path, and
 * `ConvertFrom-Json` then throws — leaving the relaunched application with an
 * *empty* environment, no `TEMP`, a native-addon cache of `undefined\temp`, and
 * a startup crash before its Host is ever ready.
 */
export function restartScript(facts, logPath) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$logPath = ${psLiteral(logPath)}`,
    'function Write-Log([string]$message) {',
    '  try { Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString("o") + " " + $message) -Encoding UTF8 } catch { }',
    '}',
    "Write-Log ('helper start pid=' + $PID)",
    'Start-Sleep -Milliseconds 900',
    `$applicationDirectory = ${psLiteral(facts.applicationDirectory)}`,
    `$processName = ${psLiteral(facts.processName)}`,
    `$executable = ${psLiteral(facts.executable)}`,
    '',
    '# Drop the shell markers so the application starts the way the user started',
    '# it: `ELECTRON_RUN_AS_NODE` would turn the shell into a plain Node runtime.',
    'Remove-Item -Path Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    'Remove-Item -Path Env:DSH_DESKTOP_NODE_EXECUTABLE -ErrorAction SilentlyContinue',
    '',
    '# An application with no TEMP cannot start: the shell resolves its own',
    '# native-addon cache against `os.tmpdir()`, which without TEMP/TMP is the',
    '# literal relative path `undefined\\temp`, and the Host then dies with "No',
    '# usable native binding found". Nothing here should ever be missing, but the',
    '# cost of a fallback is one line and the cost of the crash was the app.',
    'if ([string]::IsNullOrEmpty($env:TEMP) -or [string]::IsNullOrEmpty($env:TMP)) {',
    '  $fallback = $null',
    '  if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) { $fallback = Join-Path $env:LOCALAPPDATA "Temp" }',
    '  elseif (-not [string]::IsNullOrEmpty($env:USERPROFILE)) { $fallback = Join-Path $env:USERPROFILE "AppData\\Local\\Temp" }',
    '  else { $fallback = [System.IO.Path]::GetTempPath() }',
    '  $env:TEMP = $fallback',
    '  $env:TMP = $fallback',
    "  Write-Log ('warning: TEMP was missing; using ' + $fallback)",
    '}',
    '',
    '# Select this application only: its image name, or any executable under',
    '# its directory. The helper itself is a powershell.exe under %TEMP%, so it',
    '# never selects itself and never needs a process-tree walk.',
    'function Get-Targets {',
    '  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {',
    '    if ($_.Id -eq $PID) { return $false }',
    '    if ($_.ProcessName -eq $processName) { return $true }',
    '    $path = $null',
    '    try { $path = $_.Path } catch { $path = $null }',
    '    if ($path -eq $null) { return $false }',
    '    return $path.StartsWith($applicationDirectory, [System.StringComparison]::OrdinalIgnoreCase)',
    '  })',
    '}',
    '',
    '$targets = Get-Targets',
    "Write-Log ('stopping ' + $targets.Count + ' application process(es): ' + (($targets | ForEach-Object { $_.Id }) -join ','))",
    'foreach ($target in $targets) {',
    '  try { Stop-Process -Id $target.Id -Force -ErrorAction Stop } catch { Write-Log ("stop failed for " + $target.Id + ": " + $_.Exception.Message) }',
    '}',
    '',
    '$deadline = (Get-Date).AddSeconds(25)',
    'while ((Get-Date) -lt $deadline) {',
    '  if ((Get-Targets).Count -eq 0) { break }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    "Write-Log 'application processes are gone'",
    'Start-Sleep -Milliseconds 500',
    '',
    "Write-Log ('relaunching ' + $executable)",
    'try {',
    '  $child = Start-Process -FilePath $executable -WorkingDirectory $applicationDirectory -PassThru -ErrorAction Stop',
    "  Write-Log ('relaunched pid=' + $child.Id)",
    '} catch {',
    "  Write-Log ('relaunch failed: ' + $_.Exception.Message)",
    '}',
    '',
    '# Say whether the new application survived its own startup. A shell that',
    '# dies within five seconds has already written a crash report, and this log',
    '# is what points at it.',
    'if ($child -ne $null) {',
    '  Start-Sleep -Seconds 5',
    '  if (Get-Process -Id $child.Id -ErrorAction SilentlyContinue) {',
    "    Write-Log ('relaunched application is alive after 5s (pid=' + $child.Id + ')')",
    '  } else {',
    "    Write-Log ('relaunched application exited within 5s; see the desktop crash reports')",
    '  }',
    '}',
    "Write-Log 'helper done'",
    '',
  ].join('\r\n')
}

/**
 * stage.ps1 — start the helper without becoming its parent: `Start-Process`
 * hands it to the shell, and this script exits immediately, so the helper has
 * no live ancestor inside the application's process tree by the time the
 * application is stopped.
 */
export function stageScript(restartPath) {
  const argumentList = [
    "'-NoProfile'",
    "'-ExecutionPolicy'",
    "'Bypass'",
    "'-WindowStyle'",
    "'Hidden'",
    `'-File'`,
    psLiteral(restartPath),
  ].join(',')
  return [
    "$ErrorActionPreference = 'Continue'",
    `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${argumentList}) -WindowStyle Hidden`,
    '',
  ].join('\r\n')
}
