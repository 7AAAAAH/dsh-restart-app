/**
 * Client half of dsh-restart-app: one control in the sidebar's foot row
 * (`sidebar.footer.action`, kind `list`, scope `root`, props `{ wide }`).
 *
 * The control asks the Host whether this page belongs to the desktop
 * application first; on a plain `dsh web` Host it renders nothing, so no click
 * can ever ask a browser session to kill its own terminal.
 *
 * One click posts: the Host answers 202 and then kills and relaunches itself, so
 * this page waits for the server to answer again and reloads into the fresh
 * application. A second click while that is under way is ignored.
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
        idle: '重启 DSH',
        idleTitle: '重启 DeepSeek Harness（整个应用）',
        posting: '正在重启…',
        postingTitle: '正在请求重启',
        waiting: '等待应用启动…',
        waitingTitle: '应用已退出，正在等待它重新启动',
        error: '重启失败',
        errorTitle: '重启请求失败',
        timeout: '等待超时：应用若已用新地址打开，请在新窗口继续，本页可以关闭。',
      },
    }

    const EN = {
      action: {
        idle: 'Restart DSH',
        idleTitle: 'Restart DeepSeek Harness (the whole application)',
        posting: 'Restarting…',
        postingTitle: 'Requesting a restart',
        waiting: 'Waiting for the app…',
        waitingTitle: 'The application has quit; waiting for it to start again',
        error: 'Restart failed',
        errorTitle: 'The restart request failed',
        timeout: 'Timed out: if the app reopened elsewhere, continue there; this page can be closed.',
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

    const LABELS = (t) => ({
      idle: { text: t('action.idle'), title: t('action.idleTitle') },
      posting: { text: t('action.posting'), title: t('action.postingTitle') },
      waiting: { text: t('action.waiting'), title: t('action.waitingTitle') },
      error: { text: t('action.error'), title: t('action.errorTitle') },
    })

    function RestartControl(props) {
      const wide = props !== undefined && props.wide === true
      const t = translator(props)
      const labels = LABELS(t)
      const [phase, setPhase] = useState('loading')
      const [message, setMessage] = useState('')
      const [hover, setHover] = useState(false)
      const busyRef = useRef(false)

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
          for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
            await delay(POLL_MS)
            try {
              const probe = await request('/')
              if (probe.ok) {
                window.location.reload()
                return
              }
            } catch {
              // The server is still down; keep waiting.
            }
          }
          setPhase('error')
          setMessage(t('action.timeout'))
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

      const label = labels[phase] || labels.idle
      const disabled = phase === 'posting' || phase === 'waiting'
      const detail = phase === 'error' && message !== '' ? message : label.title
      const showText = wide || phase !== 'idle'
      const text = phase === 'error' && message !== '' ? message : label.text

      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: wide ? 180 : 'none',
        padding: '4px 6px',
        border: 'none',
        borderRadius: 6,
        background: hover && !disabled ? 'var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '16px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 0.8,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        transition: 'background 120ms ease, opacity 120ms ease',
      }

      return h('button', {
        type: 'button',
        onClick: handleClick,
        disabled,
        title: detail,
        'aria-label': label.title,
        'data-phase': phase,
        style,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
        h(RestartGlyph, { size: 15 }),
        showText ? h('span', { key: 'label', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, text) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          locale: NS,
          id: 'dsh-restart-app',
          order: 30,
          registrant: 'dsh-restart-app',
        }, RestartControl))
      },
    }
  },
})
