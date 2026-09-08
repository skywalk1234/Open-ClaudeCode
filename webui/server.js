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
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const CLI = path.join(ROOT, 'package', 'cli.js')
const DEFAULT_PORT = 8787

// Conversations survive server restarts via a small JSON store on disk.
const STORE_DIR = path.join(os.homedir(), '.opc-webui')
const STORE_FILE = path.join(STORE_DIR, 'conversations.json')
// The DeepSeek API key the user provides in the UI is kept here and read back
// on every server start (never committed, it lives outside the repo).
const CONFIG_FILE = path.join(STORE_DIR, 'config.json')

// Only the DeepSeek Anthropic-compatible gateway is supported for now.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'
// UI aliases → real DeepSeek model ids (anything else is passed through as-is).
const MODEL_IDS = { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' }
const resolveModel = m => MODEL_IDS[String(m || '').trim()] || (m || null)

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
ANTHROPIC_MODEL) and ~/.claude/settings.json when no --settings is given.

Every spawned CLI talks to the DeepSeek Anthropic-compatible gateway using the
API key saved from the UI into ~/.opc-webui/config.json. Ambient
ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL from the shell are
deliberately stripped so no previously wired-in key is used.`)
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
  constructor({ cwd, settings, model, thinking, env, permissionMode, resumeSessionId, forkSession, onEvent }) {
    this.cwd = cwd
    this.onEvent = onEvent
    this.env = env
    this.resumeSessionId = resumeSessionId || null
    this.forkSession = Boolean(forkSession) // resume into a NEW session id
    this.sessionId = null // CLI session id, captured from stream events
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
    if (thinking) args.push('--thinking', thinking)
    this.baseArgs = args
  }

  start(prompt) {
    const args = [...this.baseArgs]
    // Continue an existing conversation: the CLI loads the transcript and
    // appends the new turn, keeping multi-turn context. With forkSession the
    // turn lands in a NEW session id, leaving the source transcript intact.
    if (this.resumeSessionId) {
      args.push('--resume', this.resumeSessionId)
      if (this.forkSession) args.push('--fork-session')
    }
    args.push('-p', prompt)
    this.child = spawn(process.execPath, args, {
      cwd: this.cwd,
      env: this.env || { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
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
    if (event.session_id) this.sessionId = event.session_id
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
// conversation store (persisted to disk)
// ---------------------------------------------------------------------------
function loadConversations() {
  try {
    const list = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
    return new Map(Array.isArray(list) ? list.map(c => [c.id, c]) : [])
  } catch {
    return new Map()
  }
}

function saveConversations(map) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    fs.writeFileSync(STORE_FILE, JSON.stringify([...map.values()], null, 2))
  } catch {
    /* best effort — the UI still works with in-memory state */
  }
}

// ---------------------------------------------------------------------------
// config store: the user-provided DeepSeek API key lives in ~/.opc-webui/
// config.json and is read back automatically whenever the server starts.
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return { apiKey: String(cfg.apiKey || '').trim(), baseUrl: String(cfg.baseUrl || '').trim() }
  } catch {
    return { apiKey: '', baseUrl: '' }
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
    return true
  } catch {
    return false
  }
}

// Env for every spawned CLI: DeepSeek gateway only, and the auth token is the
// one the user configured in the UI — any ANTHROPIC_API_KEY / AUTH_TOKEN /
// MODEL from the ambient shell are deliberately stripped so the previously
// wired-in key stops being used.
function buildChildEnv(config) {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_MODEL
  env.ANTHROPIC_BASE_URL = config.baseUrl || DEEPSEEK_BASE_URL
  env.FORCE_COLOR = '0'
  env.NO_COLOR = '1'
  const key = String(config.apiKey || '').trim()
  if (key) {
    env.ANTHROPIC_API_KEY = key
    env.ANTHROPIC_AUTH_TOKEN = key
  }
  return env
}

// ---------------------------------------------------------------------------
// transcript reading (history view): the CLI stores each conversation's events
// as JSONL under ~/.claude/projects/<project>/<sessionId>.jsonl. We rebuild the
// readable history from that file (user prompts live in `queue-operation
// enqueue` records, assistant text/thinking/tool_use arrive as per-block events).
// ---------------------------------------------------------------------------
function findTranscriptFile(sessionId) {
  if (!sessionId) return null
  const base = path.join(os.homedir(), '.claude', 'projects')
  let dirs = []
  try {
    dirs = fs.readdirSync(base)
  } catch {
    return null
  }
  for (const dir of dirs) {
    if (dir.startsWith('.')) continue
    const fp = path.join(base, dir, sessionId + '.jsonl')
    try {
      if (fs.statSync(fp).isFile()) return fp
    } catch {
      /* not this project dir — keep looking */
    }
  }
  return null
}

function parseTranscriptTurns(file) {
  const turns = []
  const events = []
  for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      events.push(JSON.parse(s))
    } catch {
      /* skip malformed lines */
    }
  }
  // tool_use ids that eventually received a tool_result => their card is "done"
  const resolved = new Set()
  for (const o of events) {
    if (o.type !== 'user') continue
    for (const b of o.message?.content || []) {
      if (b && b.tool_use_id) resolved.add(b.tool_use_id)
    }
  }
  let cur = null
  for (const o of events) {
    if (o.type === 'queue-operation' && o.operation === 'enqueue') {
      cur = {
        prompt: typeof o.content === 'string' ? o.content : '',
        ts: o.timestamp || null,
        blocks: [],
      }
      turns.push(cur)
      continue
    }
    if (!cur) continue
    if (o.type === 'assistant') {
      const msg = o.message
      // resume-loading boilerplate the CLI inserts ("Continue from where you
      // left off." paired with a synthetic "No response requested." assistant)
      if (!msg || msg.model === '<synthetic>') continue
      for (const b of msg.content || []) {
        if (!b) continue
        if (b.type === 'thinking') {
          cur.blocks.push({ type: 'think', text: String(b.thinking || '') })
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          cur.blocks.push({ type: 'text', text: b.text })
        } else if (b.type === 'tool_use') {
          cur.blocks.push({
            type: 'tool',
            id: b.id,
            name: b.name || 'tool',
            input: b.input || {},
            done: resolved.has(b.id),
          })
        }
      }
    }
  }
  return turns
}

// ---------------------------------------------------------------------------
// HTTP + SSE server
// ---------------------------------------------------------------------------
function createServer(opts) {
  const sessions = new Map() // chatId -> CliSession (one run)
  const conversations = loadConversations() // conversationId -> conversation record
  let config = loadConfig() // { apiKey, baseUrl } — the DeepSeek key from the UI
  const clients = new Set() // SSE response objects
  const eventLog = [] // ring buffer so late SSE clients catch up
  const EVENT_LOG_MAX = 500

  function touchConversation(conv) {
    conv.updatedAt = Date.now()
    saveConversations(conversations)
  }

  // A restart kills every child CLI process, so any conversation still flagged
  // as "running" can never finish on its own — clear the flag or the session
  // would be stuck undeletable and permanently shown as running.
  let stale = false
  for (const conv of conversations.values()) {
    if (conv.running) {
      conv.running = false
      stale = true
    }
  }
  if (stale) saveConversations(conversations)

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

    // UI config probe: has the user saved a DeepSeek key? (never return the key)
    if (req.method === 'GET' && p === '/api/config') {
      const key = String(config.apiKey || '')
      sendJson(res, 200, {
        hasApiKey: Boolean(key),
        apiKeyLast4: key.length > 4 ? key.slice(-4) : '',
        baseUrl: config.baseUrl || DEEPSEEK_BASE_URL,
        modelDefault: resolveModel('flash'),
        root: ROOT, // repo root, for the cwd-picker quick jump
        home: os.homedir(), // same, for the "主目录" quick jump
      })
      return
    }

    // Directory browser for the cwd picker (localhost tooling, dirs only).
    if (req.method === 'GET' && p === '/api/fs/dir') {
      const raw = String(url.searchParams.get('path') || '').trim()
      const start = raw ? path.resolve(raw) : ROOT
      let stat
      try {
        stat = fs.statSync(start)
      } catch {
        return sendJson(res, 400, { error: '路径不存在: ' + start })
      }
      if (!stat.isDirectory()) return sendJson(res, 400, { error: '不是目录: ' + start })
      let names = []
      try {
        names = fs.readdirSync(start, { withFileTypes: true })
      } catch {
        return sendJson(res, 400, { error: '无法读取该目录（权限不足？）' })
      }
      const dirs = names
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, full: path.join(start, d.name) }))
        .sort((a, b) => {
          const ah = a.name.startsWith('.') ? 1 : 0
          const bh = b.name.startsWith('.') ? 1 : 0
          if (ah !== bh) return ah - bh
          return a.name.localeCompare(b.name, undefined, { numeric: true })
        })
      const parent = path.dirname(start)
      const atRoot = parent === start // e.g. C:\ on Windows or / on POSIX
      let drives = []
      if (atRoot && process.platform === 'win32') {
        for (let i = 65; i <= 90; i++) {
          const d = String.fromCharCode(i) + ':\\'
          try {
            if (fs.statSync(d).isDirectory()) drives.push({ name: d, full: d, drive: true })
          } catch {
            /* no such drive */
          }
        }
      }
      sendJson(res, 200, {
        path: start,
        parent: atRoot ? null : parent,
        atRoot,
        drives, // sibling drives shown only at a drive root on Windows
        entries: dirs,
      })
      return
    }

    // Conversation list for the sidebar
    if (req.method === 'GET' && p === '/api/conversations') {
      const list = [...conversations.values()]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(({ id, title, cliSessionId, forkedFrom, createdAt, updatedAt, running, entryPrompt, forkQuote }) => ({
          id,
          title,
          hasTranscript: Boolean(cliSessionId),
          forkedFrom: forkedFrom || null,
          createdAt,
          updatedAt,
          running: Boolean(running),
          entryPreview: String(entryPrompt || title || '').slice(0, 300),
          forkQuote: String(forkQuote || '').slice(0, 300),
        }))
      sendJson(res, 200, list)
      return
    }

    // Full history for one conversation, rebuilt from the CLI transcript.
    if (req.method === 'GET') {
      const m = p.match(/^\/api\/conversations\/([^/]+)\/messages$/)
      if (m) {
        const conv = conversations.get(m[1])
        if (!conv) return sendJson(res, 404, { error: 'Conversation not found' })
        const file = findTranscriptFile(conv.cliSessionId)
        const turns = file ? parseTranscriptTurns(file) : []
        sendJson(res, 200, {
          id: conv.id,
          title: conv.title,
          running: conv.running,
          cliSessionId: conv.cliSessionId,
          turns,
        })
        return
      }
    }

    // Delete a conversation (record + its CLI transcript).
    if (req.method === 'DELETE') {
      const m = p.match(/^\/api\/conversations\/([^/]+)$/)
      if (m) {
        const conv = conversations.get(m[1])
        if (!conv) return sendJson(res, 404, { error: 'Conversation not found' })
        if (conv.running) {
          return sendJson(res, 409, { error: '该会话正在运行，请先停止。' })
        }
        conversations.delete(m[1])
        saveConversations(conversations)
        // A freshly forked conversation briefly shares its parent's cliSessionId
        // (until the CLI reports its own new session id). Only unlink the
        // transcript when THIS conversation is its sole owner — otherwise we'd
        // destroy history still referenced by the fork source.
        const owners = [...conversations.values()].filter(
          x => x.cliSessionId && x.cliSessionId === conv.cliSessionId,
        )
        if (!owners.length) {
          const file = findTranscriptFile(conv.cliSessionId)
          if (file) {
            try {
              fs.unlinkSync(file)
            } catch {
              /* best effort */
            }
          }
        }
        sendJson(res, 200, { ok: true })
        return
      }
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

      // Save (or clear, with an empty apiKey) the user's DeepSeek API key.
      if (p === '/api/config') {
        const key = String(body.apiKey ?? '').trim()
        config = { ...config, apiKey: key }
        const saved = saveConfig(config)
        sendJson(res, saved ? 200 : 500, {
          ok: saved,
          hasApiKey: Boolean(key),
          apiKeyLast4: key.length > 4 ? key.slice(-4) : '',
        })
        return
      }

      // Start a new one-shot CLI run for a chat message. When conversationId
      // refers to an existing conversation, the CLI resumes its transcript so
      // the turn continues with full context. forkFrom instead creates a NEW
      // conversation that branches off the source transcript (--fork-session),
      // leaving the source conversation untouched.
      if (p === '/api/chat') {
        const prompt = String(body.prompt || '').trim()
        if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })
        if (!String(config.apiKey || '').trim()) {
          return sendJson(res, 409, { error: '尚未配置 DeepSeek API Key，请在页面顶部填写并保存。' })
        }
        let conv = null
        let forkSession = false
        if (body.forkFrom) {
          const src = conversations.get(String(body.forkFrom)) || null
          if (!src) return sendJson(res, 404, { error: 'Fork source conversation not found' })
          if (!src.cliSessionId) {
            return sendJson(res, 409, { error: '源会话还没有可继承的上下文' })
          }
          if (src.running) {
            return sendJson(res, 409, { error: '源会话有任务在运行，请先停止。' })
          }
          conv = {
            id: 'conv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            title: String(body.title || prompt).slice(0, 40),
            entryPrompt: String(body.entry || prompt).slice(0, 600), // first msg of this branch
            forkQuote: String(body.quote || '').slice(0, 600), // the selected AI text this fork asked about
            cliSessionId: src.cliSessionId,
            forkedFrom: src.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            running: false,
          }
          conversations.set(conv.id, conv)
          forkSession = true
        } else if (body.conversationId) {
          conv = conversations.get(String(body.conversationId)) || null
          if (!conv) return sendJson(res, 404, { error: 'Conversation not found' })
        }
        if (conv && conv.running) {
          return sendJson(res, 409, { error: '该会话已有任务在运行，请先停止。' })
        }
        if (!conv) {
          conv = {
            id: 'conv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            title: String(body.title || prompt).slice(0, 40),
            entryPrompt: String(body.entry || prompt).slice(0, 600), // first msg of this branch
            cliSessionId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            running: false,
          }
          conversations.set(conv.id, conv)
        }
        const chatId = String(body.chatId || `chat-${Date.now()}`)
        conv.running = true
        touchConversation(conv)
        const convRef = conv
        const thinking = ['disabled', 'adaptive', 'enabled'].includes(String(body.thinking || '').trim())
          ? String(body.thinking).trim()
          : null
        const session = new CliSession({
          cwd: body.cwd || opts.cwd || ROOT,
          settings: body.settings || opts.settings || null,
          model: resolveModel(body.model) || resolveModel(opts.model) || resolveModel('flash'),
          thinking,
          env: buildChildEnv(config),
          permissionMode: body.permissionMode || 'acceptEdits',
          resumeSessionId: convRef.cliSessionId,
          forkSession,
          onEvent: ev => {
            // Track the CLI session id so the next message can --resume it.
            if (ev.session_id && ev.session_id !== convRef.cliSessionId) {
              convRef.cliSessionId = ev.session_id
              touchConversation(convRef)
            }
            broadcast({ chatId, ...ev })
          },
        })
        sessions.set(chatId, session)
        const run = session.start(prompt)
        run.child.once('close', () => {
          sessions.delete(chatId)
          convRef.running = false
          touchConversation(convRef)
        })
        sendJson(res, 200, { chatId, conversationId: convRef.id, pid: run.child.pid })
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
