/**
 * Client half of dsh-restart-app: one icon button in the window's top-left
 * strip, just right of the sidebar toggle.
 *
 * The button registers into `shell.overlay` (kind `list`, scope `root`, always
 * mounted) rather than the sidebar foot: the foot is hidden while the sidebar is
 * collapsed, and the sidebar package's `shell.leading` seat is only rendered on
 * macOS. `shell.overlay` is a full-window layer whose direct children get
 * `pointer-events: auto`, so an absolutely positioned button there sits in the
 * titlebar without disturbing the layout.
 *
 * The application's own menu strip starts at `--dsh-windows-menu-start` (48px),
 * exactly where this button goes, so the injected CSS pushes that variable to
 * the right of the button — 84px normally, 120px when the sidebar is collapsed
 * (the collapsed layout parks its new-session button at 48px, so the button
 * itself moves to 84px there).
 *
 * The control asks the Host whether this page belongs to the desktop
 * application first; on a plain `dsh web` Host it renders nothing, so no click
 * can ever ask a browser session to kill its own terminal.
 *
 * One click posts: the Host answers 202 and then kills and relaunches itself.
 * The page then waits for the server to go DOWN and come back before reloading,
 * because the helper sleeps before it kills anything — an early successful probe
 * is still the old process and reloading on it is the "soft restart" that used
 * to happen before the real one. A second click while that is under way is
 * ignored.
 *
 * No Harness Client package is imported: React comes from the browser module
 * table, everything else is plain DOM and fetch. Styling follows the host's
 * theme tokens with literal fallbacks, so a renamed token degrades instead of
 * breaking. Strings go through the Client locale service: the dictionaries live
 * in this bundle (a slot only receives `t` for a namespace registered here),
 * and `locale/*.json` carries the plugin-manager metadata only.
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-app',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STATUS_PATH = '/dsh-restart-app/status'
    const RESTART_PATH = '/dsh-restart-app/restart'
    /** Revival poll: interval and budget (the Host relaunches itself). */
    const POLL_MS = 1000
    const POLL_LIMIT = 60

    /** Absolute URL on this page's origin; the Host registers absolute paths. */
    function endpoint(path) {
      return new URL(path, document.baseURI).href
    }

    /** Fetch with a short timeout so a dead server cannot hang the button. */
    async function request(path, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      try {
        return await fetch(endpoint(path), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
          ...options,
        })
      } finally {
        clearTimeout(timer)
      }
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** Locale namespace of this plugin; the slot is registered under it. */
    const NS = 'dsh-restart-app'

    /**
     * Dictionaries for the Client locale service. Kept here rather than in
     * `locale/*.json`: the `t` seat reaches a slot only when its namespace is
     * registered in this bundle.
     */
    const ZH = {
      action: {
        idleTitle: '重启 DeepSeek Harness（整个应用）',
        postingTitle: '正在请求重启',
        waitingTitle: '应用已退出，正在等待它重新启动',
        errorTitle: '重启请求失败',
        timeout: '等待超时：应用若已用新地址打开，请在新窗口继续，本页可以关闭。',
        stuck: '重启似乎没有生效：应用仍在运行。',
      },
    }

    const EN = {
      action: {
        idleTitle: 'Restart DeepSeek Harness (the whole application)',
        postingTitle: 'Requesting a restart',
        waitingTitle: 'The application has quit; waiting for it to start again',
        errorTitle: 'The restart request failed',
        timeout: 'Timed out: if the app reopened elsewhere, continue there; this page can be closed.',
        stuck: 'The restart did not take effect: the application is still running.',
      },
    }

    /** The dictionary to translate with, tolerant of a slot without `locale`. */
    function translator(props) {
      if (props !== undefined && typeof props.t === 'function') return props.t
      return (key) => {
        const [scope, name] = key.split('.')
        return ZH[scope] !== undefined && ZH[scope][name] !== undefined ? ZH[scope][name] : key
      }
    }

    /**
     * Sheet for the button and the menu-strip offset. The `:has()` rule repeats
     * `data-windows-titlebar` to outrank the sidebar package's own
     * `html[data-windows-titlebar]:has(...)` rule (specificity 0,2,1); a tie
     * would depend on which `<style>` landed last, and the menu would slide back
     * under the button whenever the sidebar collapses.
     */
    const STYLE_ID = `${NS}:style`
    const MENU = 'html[data-windows-titlebar][data-windows-titlebar][data-windows-titlebar]'
    const CSS = [
      '[data-restart-app]{position:absolute;top:6px;left:48px;z-index:30;display:inline-flex;',
      'align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin:0;',
      'border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;pointer-events:auto;',
      '-webkit-app-region:no-drag;transition:background 120ms ease,color 120ms ease,opacity 120ms ease}',
      '[data-restart-app]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '[data-restart-app]:disabled{cursor:default;opacity:.55}',
      '[data-restart-app][data-phase="error"]{color:var(--dsw-alias-label-error,#d33)}',
      'html[data-windows-titlebar] [data-restart-app]{top:calc((var(--dsh-windows-titlebar-height,40px) - 28px) / 2)}',
      'html[data-windows-titlebar] [data-sidebar-collapsed="true"] [data-restart-app]{left:84px}',
      `${MENU}{--dsh-windows-menu-start:84px}`,
      `${MENU}:has([data-sidebar-collapsed="true"]){--dsh-windows-menu-start:120px}`,
    ].join('')

    function useStyleSheet() {
      useEffect(() => {
        if (document.getElementById(STYLE_ID) !== null) return undefined
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = CSS
        document.head.appendChild(element)
        return () => {
          if (element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, [])
    }

    /** Restart glyph: a circular arrow, drawn in `currentColor`. */
    function RestartGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }),
        h('path', { d: 'M20.5 4.5v5h-5' }),
      )
    }

    function RestartControl(props) {
      const t = translator(props)
      const [phase, setPhase] = useState('loading')
      const [message, setMessage] = useState('')
      const busyRef = useRef(false)
      useStyleSheet()

      // Ask the Host once whether a restart is possible here.
      useEffect(() => {
        let live = true
        request(STATUS_PATH)
          .then((response) => response.json())
          .then((body) => {
            if (!live) return
            setPhase(body !== null && typeof body === 'object' && body.desktop === true ? 'idle' : 'hidden')
          })
          .catch(() => {
            if (live) setPhase('hidden')
          })
        return () => { live = false }
      }, [])

      const runRestart = useCallback(async () => {
        if (busyRef.current) return
        busyRef.current = true
        setPhase('posting')
        try {
          const response = await request(RESTART_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) {
            setPhase('error')
            setMessage(typeof body.reason === 'string' ? body.reason : `HTTP ${response.status}`)
            busyRef.current = false
            return
          }
          setPhase('waiting')
          // The helper sleeps before it kills anything, so the first probes still
          // reach the process that is about to die. Only a down-then-up sequence
          // means the new instance answered; reloading on an early success would
          // bounce the page against the old server first.
          let sawDown = false
          for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
            await delay(POLL_MS)
            let up = false
            try {
              const probe = await request('/')
              up = probe.ok
            } catch {
              up = false
            }
            if (!up) {
              sawDown = true
              continue
            }
            if (sawDown) {
              window.location.reload()
              return
            }
          }
          setPhase('error')
          setMessage(t(sawDown ? 'action.timeout' : 'action.stuck'))
          busyRef.current = false
        } catch (error) {
          setPhase('error')
          setMessage(error instanceof Error ? error.message : String(error))
          busyRef.current = false
        }
      }, [t])

      const handleClick = useCallback(() => {
        void runRestart()
      }, [runRestart])

      if (phase === 'loading' || phase === 'hidden') return null

      const disabled = phase === 'posting' || phase === 'waiting'
      const title = phase === 'error' && message !== '' ? message : t(`action.${phase}Title`)

      return h('button', {
        type: 'button',
        onClick: handleClick,
        disabled,
        title,
        'aria-label': t('action.idleTitle'),
        'data-restart-app': '',
        'data-phase': phase,
      }, h(RestartGlyph, { size: 16 }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          locale: NS,
          id: 'dsh-restart-app',
          order: 30,
          registrant: 'dsh-restart-app',
        }, RestartControl))
      },
    }
  },
})
