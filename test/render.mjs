/**
 * Dependency-free checks for the pieces that are pure functions.
 *
 * The interesting part of this plugin is the text of the two PowerShell scripts
 * it writes, and that text is easy to break silently: one stray line and the
 * relaunched application inherits a broken environment, which shows up as a
 * crash report seconds later and nothing else. So the invariants that took a
 * crash to learn are asserted here.
 *
 * Run: node test/render.mjs
 */
import { strict as assert } from 'node:assert'
import { restartScript, stageScript, desktopFacts } from '../index.js'

const facts = {
  executable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  processName: 'DeepSeek Harness',
  applicationDirectory: 'C:\\Program Files\\DeepSeek Harness',
}
const logPath = 'C:\\Users\\someone\\AppData\\Local\\Temp\\dsh-restart-app\\stamp\\helper.log'
const restart = restartScript(facts, logPath)
const stage = stageScript('C:\\Temp\\stamp\\restart.ps1')

let passed = 0
function check(name, condition) {
  assert.ok(condition, name)
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// The environment must never travel through a file again. PowerShell 5.1
// decodes a BOM-less file as the ANSI code page, so a non-ASCII PATH either
// mangles or makes ConvertFrom-Json throw after the environment was already
// cleared — and an application with no TEMP cannot load its native addons.
check('no JSON round trip of the environment', !/ConvertFrom-Json|Get-Content|env\.json/.test(restart))
check('no EnvironmentVariables / ProcessStartInfo', !/EnvironmentVariables|ProcessStartInfo/.test(restart))
check('drops ELECTRON_RUN_AS_NODE', restart.includes('Remove-Item -Path Env:ELECTRON_RUN_AS_NODE'))
check('drops DSH_DESKTOP_NODE_EXECUTABLE', restart.includes('Remove-Item -Path Env:DSH_DESKTOP_NODE_EXECUTABLE'))
check('falls back when TEMP is missing', /IsNullOrEmpty\(\$env:TEMP\)/.test(restart) && /\$env:TEMP = \$fallback/.test(restart))
check('relaunches with Start-Process', /Start-Process -FilePath \$executable -WorkingDirectory \$applicationDirectory/.test(restart))
check('selects victims by image name', restart.includes("$_.ProcessName -eq $processName"))
check('selects victims by executable path', restart.includes('StartsWith($applicationDirectory'))
check('never selects the helper itself', restart.includes('if ($_.Id -eq $PID) { return $false }'))
check('reports whether the relaunched app survived', restart.includes('is alive after 5s'))
check('CRLF line endings', restart.includes('\r\n') && !/[^\r]\n/.test(restart))

check('stage hands the helper to the shell', stage.includes('Start-Process -FilePath \'powershell.exe\''))
check('stage hides its window', stage.includes('-WindowStyle Hidden'))
check('stage runs the helper with -File', stage.includes("'-File',"))
check('stage does not wait for the helper', !/Wait-Process|Wait-Exit/.test(stage))

// One apostrophe in a path must not end the PowerShell literal.
const quoted = restartScript({ ...facts, applicationDirectory: "C:\\it's here" }, logPath)
check('quotes apostrophes by doubling them', quoted.includes("'C:\\it''s here'"))

// The button must stay hidden where a restart makes no sense.
const found = desktopFacts()
check('desktopFacts answers with a record', typeof found === 'object' && typeof found.ok === 'boolean')
if (!found.ok) check('a hidden button carries a reason', typeof found.reason === 'string' && found.reason.length > 0)
if (found.ok) check('a usable record carries its facts', typeof found.executable === 'string' && typeof found.processName === 'string')

console.log(`\n${passed} checks passed`)
