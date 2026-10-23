/**
 * Host half of dsh-restart-app: two routes on the composition's `webServer`.
 *
 * `GET /dsh-restart-app/status` reports whether this Host really belongs to the
 * desktop application, so the sidebar button hides itself elsewhere: a `dsh web`
 * Host must never offer a restart, because `process.ppid` there is the user's
 * terminal.
 *
 * `POST /dsh-restart-app/restart` answers 202 and then runs one detached helper:
 *
 *   restart.ps1 sleeps briefly, stops every process of the application, waits
 *   for the executable to leave the process table, and starts it again from the
 *   helper's own environment.
 *
 * The helper is a `powershell.exe` living under %TEMP%, and it selects its
 * victims by image name or by executable path under the application directory —
 * never `taskkill /T` and never "the child tree of some pid". That is what lets
 * it outlive the application: tree walks and job objects reach descendants, but
 * not a sibling process that merely shares the parent.
 *
 * It is started in two steps — this Host spawns a stage script, the stage script
 * `Start-Process`es the real helper and exits at once — because a Node
 * `detached: true` spawn dies on this platform, while a helper whose own parent
 * has already exited survives both the parent and the rest of its tree.
 *
 * The relaunched application inherits the helper's own environment, which is
 * this Host's environment, which is the application's environment plus two
 * shell markers. The helper deletes exactly those two markers from itself and
 * starts the executable: no environment is ever copied through a file, because
 * a JSON round trip through PowerShell decodes as the ANSI code page and either
 * mangles every non-ASCII path or fails outright — and an environment with no
 * `TEMP` makes the shell's own native-addon cache resolve to `undefined\temp`
 * and the application dies before its Host is ready.
 *
 * Verified on the packaged Windows desktop: the shell's main process starts this
 * Host as a run-as-node child (`DeepSeek Harness.exe --expose-internals
 * ...dsh-desktop-host/lib/index.js`), so `process.execPath` here is the shell's
 * own executable, `process.versions.electron` is set, and every renderer and
 * helper of the app carries the same image name — stopping by image name stops
 * the whole application, and starting `process.execPath` brings it back.
 *
 * The script text itself lives in `./scripts.js`, which has no `ctx` and no I/O,
 * so `test/render.mjs` can assert its invariants with nothing running.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopFacts, restartScript, stageScript } from './scripts.js'

export { desktopFacts, restartScript, stageScript }

/** Cordis function-plugin name. */
export const name = 'dsh-restart-app'

/** The route carrier plus the trust fence guarding both routes. */
export const inject = ['webServer', 'connection']

/** Status route the browser reads before showing its button. */
const STATUS_PATH = '/dsh-restart-app/status'
/** Restart route the browser posts to. */
const RESTART_PATH = '/dsh-restart-app/restart'
/** Effect labels and the helper's scratch directory under %TEMP%. */
const LABEL = 'dsh-restart-app'
const SCRATCH = join(tmpdir(), 'dsh-restart-app')

/** Answer with JSON and no caching. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Write the helper and its stage, then start the stage.
 * @returns the scratch directory and the helper log path.
 */
async function schedule(facts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const directory = join(SCRATCH, stamp)
  await mkdir(directory, { recursive: true })
  const restartPath = join(directory, 'restart.ps1')
  const stagePath = join(directory, 'stage.ps1')
  const logPath = join(directory, 'helper.log')
  await writeFile(restartPath, restartScript(facts, logPath), 'utf8')
  await writeFile(stagePath, stageScript(restartPath), 'utf8')

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // No `stdio: 'ignore'` and no `detached: true`: on this platform a child
  // started with either flag is reaped at once, while an ordinary child that
  // hands the real helper to the shell runs to completion.
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stagePath], {
    cwd: directory,
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
  return { directory, logPath }
}

/**
 * Register both routes. Each registration is an effect: removing the plugin
 * removes the routes.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  /** Set once a restart is scheduled so a second click cannot double-kill. */
  let scheduled = null

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendJson(res, 405, { ok: false, reason: '只接受 GET' })
        return
      }
      const facts = desktopFacts()
      if (!facts.ok) {
        sendJson(res, 200, { desktop: false, reason: facts.reason })
        return
      }
      sendJson(res, 200, {
        desktop: true,
        processName: facts.processName,
        executable: facts.executable,
        scheduled: scheduled !== null,
      })
    },
  }), `${LABEL}: GET ${STATUS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESTART_PATH,
    handler: (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, reason: '只接受 POST' })
        return
      }
      const facts = desktopFacts()
      if (!facts.ok) {
        sendJson(res, 400, { ok: false, reason: facts.reason })
        return
      }
      if (scheduled !== null) {
        sendJson(res, 202, { ok: true, already: true, ...scheduled })
        return
      }
      scheduled = { requestedAt: new Date().toISOString() }
      sendJson(res, 202, { ok: true, ...scheduled })
      schedule(facts).then((result) => {
        scheduled = { ...scheduled, ...result }
      }).catch((error) => {
        scheduled = null
        ctx.logger?.warn?.(`${LABEL}: could not schedule the restart: ${String(error)}`)
      })
    },
  }), `${LABEL}: POST ${RESTART_PATH}`)
}
