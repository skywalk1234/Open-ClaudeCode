#!/usr/bin/env node
/**
 * OPC Web UI — minimal local GUI for the bundled OPC CLI.
 *
 * Spawns `package/cli.js -p <prompt> --output-format stream-json` per chat
 * message and streams parsed events to the browser over SSE. Permission
 * requests (`control_request` / `can_use_tool`) are forwarded to the page,
 * and the user's decision is written back to the child's stdin as a
 * `control_response`.
 *
 * Pure Node.js — no dependencies beyond the bundled CLI.
 *
 * Usage:
 *   node webui/server.js [--port 8787] [--cwd /path/to/project]
 *                        [--settings path/to/settings.json] [--model sonnet]
 *   then open http://127.0.0.1:8787
 */
'use strict'

const http = require('node:http')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const CLI = path.join(ROOT, 'package', 'cli.js')
const DEFAULT_PORT = 8787

// ---------------------------------------------------------------------------
// tiny arg parser
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, cwd: null, settings: null, model: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--port') out.port = Number(next())
    else if (a === '--cwd') out.cwd = next()
    else if (a === '--settings') out.settings = next()
    else if (a === '--model') out.model = next()
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length))
    else if (a.startsWith('--cwd=')) out.cwd = a.slice('--cwd='.length)
    else if (a.startsWith('--settings=')) out.settings = a.slice('--settings='.length)
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length)
    else if (a === '--help' || a === '-h') {
      console.log(`OPC Web UI

Usage: node webui/server.js [options]

Options:
  --port <n>          Port to listen on (default ${DEFAULT_PORT})
  --cwd <dir>         Working directory for CLI sessions (default: repo root)
  --settings <file>   settings.json to pass to the CLI (API keys / env)
  --model <name>      Default model to use in new chats
  --help              Show this help

The CLI reads the usual env vars (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
ANTHROPIC_MODEL) and ~/.claude/settings.json when no --settings is given.`)
      process.exit(0)
    }
  }
  if (!fs.existsSync(CLI)) {
    console.error(`Bundled CLI not found at ${CLI}`)
    console.error('Make sure package/cli.js exists (see repository README).')
    process.exit(1)
  }
  return out
}

// ---------------------------------------------------------------------------
// one-shot CLI session (mirrors desktop/electron/cliRunner.cjs strategy)
// ---------------------------------------------------------------------------
class CliSession {
  constructor({ cwd, settings, model, permissionMode, onEvent }) {
    this.cwd = cwd
    this.onEvent = onEvent
    this.child = null
    this.buffer = ''
    this.finished = false
    this.stoppedByUser = false
    this.pendingRequests = new Map() // request_id -> control_request

    const args = [
      CLI,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', permissionMode,
    ]
    if (settings) args.push('--settings', settings)
    if (model) {
      args.push('--model', model)
      this.model = model
    }
    this.baseArgs = args
  }

  start(prompt) {
    const args = [...this.baseArgs, '-p', prompt]
    this.child = spawn(process.execPath, args, {
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // The CLI probes stdin for ~3s when it is a non-TTY pipe to decide
    // whether piped input is coming. We have nothing to pipe (the prompt is
    // passed via -p), so close stdin immediately: the CLI sees EOF, skips
    // the wait and starts right away. (Same strategy as the desktop shell,
    // which uses stdio 'ignore'.)
    this.child.stdin.end()
    this.child.stdin.on('error', () => {}) // child may close stdin early
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')

    this.child.stdout.on('data', chunk => this._onStdout(chunk))
    this.child.stderr.on('data', chunk => {
      const text = String(chunk)
      // "no stdin data received" is expected here (we close stdin on
      // purpose); don't surface it as a scary error in the UI.
      if (text.includes('no stdin data received')) return
      this.onEvent({ type: 'stderr', text: text.trimEnd() })
    })
    this.child.on('error', err => {
      if (!this.finished) this.onEvent({ type: 'error', message: err.message })
    })
    this.child.on('close', code => {
      if (this.buffer.trim()) this._handleLine(this.buffer)
      this.finished = true
      this.onEvent({
        type: 'run-end',
        code: code ?? null,
        stopped: this.stoppedByUser,
      })
    })
    this.onEvent({ type: 'run-start', pid: this.child.pid, args })
    return this
  }

  _onStdout(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() || ''
    for (const line of lines) if (line.trim()) this._handleLine(line)
  }

  _handleLine(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      this.onEvent({ type: 'stdout', text: line })
      return
    }
    // Control requests (permission prompts) are handled separately; the CLI
    // is waiting for our control_response on stdin.
    if (event.type === 'control_request') {
      const req = event.request || {}
      if (req.subtype === 'can_use_tool') {
        const id = event.request_id || ''
        this.pendingRequests.set(id, event)
        this.onEvent({
          type: 'permission_request',
          request_id: id,
          tool_name: req.request?.tool_name || 'unknown',
          input: req.request?.input || {},
          message: req.request?.message || '',
        })
      }
      return
    }
    this.onEvent(event)
  }

  respondPermission(requestId, behavior, extra = {}) {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || !this.child || this.child.stdin.destroyed) return false
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response:
          behavior === 'allow'
            ? { behavior: 'allow', updatedInput: extra.updatedInput || {} }
            : { behavior: 'deny', message: extra.message || 'Denied by user' },
      },
    }
    this.child.stdin.write(JSON.stringify(response) + '\n')
    this.pendingRequests.delete(requestId)
    this.onEvent({ type: 'permission_resolved', request_id: requestId, behavior })
    return true
  }

  stop() {
    this.stoppedByUser = true
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP + SSE server
// ---------------------------------------------------------------------------
function createServer(opts) {
  const sessions = new Map() // chatId -> CliSession
  const clients = new Set() // SSE response objects
  const eventLog = [] // ring buffer so late SSE clients catch up
  const EVENT_LOG_MAX = 500

  function broadcast(event) {
    eventLog.push(event)
    if (eventLog.length > EVENT_LOG_MAX) eventLog.shift()
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const res of clients) res.write(data)
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', c => {
        data += c
        if (data.length > 2 * 1024 * 1024) reject(new Error('body too large'))
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname

    // Static assets
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(__dirname, 'index.html')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      fs.createReadStream(file).pipe(res)
      return
    }
    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // SSE event stream
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      // Replay recent events so a client that connects late (or reconnects
      // after a blip) still sees the tail of what happened.
      for (const ev of eventLog) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      }
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (req.method === 'POST') {
      const raw = await readBody(req).catch(() => '{}')
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }

      // Start a new one-shot CLI session for a chat message.
      if (p === '/api/chat') {
        const prompt = String(body.prompt || '').trim()
        if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })
        const chatId = String(body.chatId || `chat-${Date.now()}`)
        if (sessions.has(chatId)) {
          return sendJson(res, 409, { error: 'A session is already running for this chat. Stop it first.' })
        }
        const session = new CliSession({
          cwd: body.cwd || opts.cwd || ROOT,
          settings: body.settings || opts.settings || null,
          model: body.model || opts.model || null,
          permissionMode: body.permissionMode || 'acceptEdits',
          onEvent: ev => broadcast({ chatId, ...ev }),
        })
        sessions.set(chatId, session)
        const run = session.start(prompt)
        run.child.once('close', () => sessions.delete(chatId))
        sendJson(res, 200, { chatId, pid: run.child.pid })
        return
      }

      // Answer a permission request for a running session.
      if (p === '/api/control') {
        const chatId = String(body.chatId || '')
        const session = sessions.get(chatId)
        if (!session) return sendJson(res, 404, { error: 'No running session for this chat.' })
        const ok = session.respondPermission(
          String(body.requestId || ''),
          body.allow ? 'allow' : 'deny',
          { message: body.message || 'Denied by user' },
        )
        return sendJson(res, ok ? 200 : 400, { ok })
      }

      // Stop a running session.
      if (p === '/api/stop') {
        const chatId = String(body.chatId || '')
        const session = sessions.get(chatId)
        if (!session) return sendJson(res, 404, { error: 'No running session for this chat.' })
        session.stop()
        return sendJson(res, 200, { ok: true })
      }

      return sendJson(res, 404, { error: 'Not found' })
    }

    sendJson(res, 404, { error: 'Not found' })
  })

  return { server, sessions }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { server } = createServer(opts)

  const shutdown = () => {
    for (const session of server.sessions?.values?.() || []) session.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`OPC Web UI running at http://127.0.0.1:${opts.port}`)
    console.log(`CLI: ${CLI}`)
    console.log(`CWD: ${opts.cwd || ROOT}`)
  })
}

main()
