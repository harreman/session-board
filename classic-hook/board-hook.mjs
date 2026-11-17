#!/usr/bin/env node
// Writes the session-board status file from ordinary Claude Code hooks, for clients that
// don't run the mod in hooks/ (the VS Code extension). Same file and schema as the mod, built
// with the mod's own helpers from hooks/lib.ts (Node 22.18+ runs TypeScript directly).
//
// Hook events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop,
// SessionEnd — each runs `node board-hook.mjs` with the hook payload on stdin.
//
// The first event also starts a detached heartbeat (`--heartbeat`). The page treats a file
// whose updatedAt stops moving for 20 s as a dead session, and the heartbeat fills in what
// hooks can't see: model, context, cache, title and turns from the transcript, and memory
// from the mod's probe. Cost stays empty: the mod reads it from the engine, hooks can't.
//
// Where the mod also runs, it owns the file. Every write here stamps hookWrittenAt equal to
// updatedAt; once updatedAt moves past that stamp, someone else is writing, and this hook
// and its heartbeat stay out of the way.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROBE, QUIET_TOOLS, cacheTtlOf, clip, freshBoard, memoryOf, parseMachine, parseProbe,
  pushEvent, sessionTitleOf, slashCommand, summarize, toolLabel, workItemOf,
} from '../hooks/lib.ts'

const BEAT_MS = 5_000
const SLOW_EVERY = 6 // beats between transcript reads (30 s)
const MEMORY_EVERY = 12 // beats between memory samples (60 s)
// The engine knows the real window; hooks don't. Claude 5 models run with 1M.
const windowOf = (model, tokens) => (/\[1m\]|-5-|-5$/.test(model || '') || tokens > 200_000 ? 1_000_000 : 200_000)

function boardDir() {
  if (process.env.SESSION_BOARD_DIR) return process.env.SESSION_BOARD_DIR
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'board')
}

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function save(file, board) {
  const now = Date.now()
  board.updatedAt = now
  board.hookWrittenAt = now
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(board, null, 1))
  fs.renameSync(tmp, file)
}

function ownedByMod(board) {
  if (!board) return false
  if (board.hookWrittenAt == null) return true
  return board.updatedAt > board.hookWrittenAt + 1_000
}

// Under Git Bash, node may not resolve `git` from PATH (its /cmd entry is POSIX-style).
const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
let gitExe

function git(cwd, args) {
  for (const exe of gitExe ? [gitExe] : GIT_CANDIDATES) {
    try {
      const out = execFileSync(exe, args, { cwd, timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      gitExe = exe
      return out.toString().trim() || null
    } catch (e) {
      if (e.code !== 'ENOENT') { gitExe = exe; return null }
    }
  }
  return null
}

function fresh(id, cwd, now) {
  const board = freshBoard(id, cwd, now)
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  if (root) {
    const rootPath = path.normalize(root)
    board.project = path.basename(rootPath)
    board.repo = { name: null, root: rootPath, remote: git(cwd, ['remote', 'get-url', 'origin']) }
  }
  board.branch = git(cwd, ['branch', '--show-current'])
  board.client = 'classic-hook'
  return board
}

const event = (board, kind, text, t) => pushEvent(board, { t, kind, text: clip(String(text ?? ''), 140) })

function setState(board, state, t = Date.now()) {
  if (board.state !== state) { board.state = state; board.stateSince = t }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function startHeartbeat(file, board) {
  if (board.hookHeartbeatPid && alive(board.hookHeartbeatPid)) return
  const owner = process.env.CLAUDE_PID || '0'
  const child = spawn(process.execPath, [process.argv[1], '--heartbeat', file, owner],
    { detached: true, stdio: 'ignore', windowsHide: true })
  board.hookHeartbeatPid = child.pid
  child.unref()
}

function handle(input) {
  const id = input.session_id
  if (!id) return
  const file = path.join(boardDir(), 'sessions', `${id}.json`)
  const now = Date.now()
  let board = load(file)
  if (ownedByMod(board)) return

  const hookEvent = input.hook_event_name
  if (!board || (hookEvent === 'SessionStart' && board.state === 'ended')) board = fresh(id, input.cwd || process.cwd(), now)
  if (input.transcript_path) board.transcriptPath = input.transcript_path

  switch (hookEvent) {
    case 'SessionStart':
      event(board, 'session', `session ${input.source || 'started'}`, now)
      break
    case 'UserPromptSubmit': {
      const prompt = String(input.prompt || '')
      const slash = slashCommand(prompt)
      board.prompt = clip(prompt, 300); board.promptAt = now; board.turns += 1; board.waiting = null
      setState(board, 'running', now)
      event(board, 'prompt', prompt, now)
      if (slash) {
        board.skill = { name: slash.name, args: slash.args, at: now }
        board.activeSkill = slash.name
        board.workItem = workItemOf(slash.args, true) ?? board.workItem
        event(board, 'skill', `${slash.name} ${slash.args}`, now)
      } else {
        board.workItem = workItemOf(prompt, false) ?? board.workItem
      }
      break
    }
    case 'PreToolUse': {
      const tool = input.tool_name || 'tool'
      const ti = input.tool_input || {}
      if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') {
        const detail = tool === 'ExitPlanMode' ? 'plan ready for review' : summarize(tool, ti)
        board.waiting = { kind: tool === 'ExitPlanMode' ? 'plan' : 'question', detail, tool, since: now }
        setState(board, 'waiting', now)
        event(board, 'waiting', detail || tool, now)
        break
      }
      if (tool === 'Skill' && typeof ti.skill === 'string') {
        const args = typeof ti.args === 'string' ? ti.args : ''
        board.skill = { name: ti.skill, args: clip(args, 200), at: now }
        board.activeSkill = ti.skill
        board.workItem = workItemOf(args, true) ?? board.workItem
        event(board, 'skill', `${ti.skill} ${args}`, now)
      }
      board.waiting = null
      setState(board, 'running', now)
      board.tools = [{ id: input.tool_use_id || String(now), tool: toolLabel(tool), summary: summarize(tool, ti), since: now }]
      if (!QUIET_TOOLS.has(tool) && tool !== 'Skill') {
        const summary = summarize(tool, ti)
        event(board, 'tool', summary ? `${toolLabel(tool)} · ${summary}` : toolLabel(tool), now)
      }
      break
    }
    case 'PostToolUse':
      board.waiting = null
      board.tools = []
      setState(board, 'running', now)
      break
    case 'Notification':
      if (input.notification_type === 'permission_prompt' || /permission/i.test(input.message || '')) {
        board.waiting = { kind: 'question', detail: clip(String(input.message || ''), 200), since: now }
        setState(board, 'waiting', now)
        event(board, 'waiting', input.message || 'permission needed', now)
      }
      break
    case 'Stop': {
      board.waiting = null
      board.tools = []
      setState(board, 'idle', now)
      const secs = board.promptAt ? Math.round((now - board.promptAt) / 1000) : null
      event(board, 'turn', secs == null ? 'turn done' : `turn done in ${secs}s`, now)
      break
    }
    case 'SessionEnd':
      board.waiting = null
      board.tools = []
      setState(board, 'ended', now)
      board.endReason = input.reason || 'ended'
      event(board, 'session', `session ended (${board.endReason})`, now)
      break
    default:
      return
  }
  // Not only on SessionStart: a session already open when the hook was installed never sees one.
  if (board.state !== 'ended') startHeartbeat(file, board)
  save(file, board)
}

// ---- Heartbeat ----------------------------------------------------------------

// What the transcript says, read incrementally: only bytes added since the last read.
function transcriptReader() {
  const st = { path: null, offset: 0, rest: '', prompts: new Set(), lastPrompt: null, model: null, usage: null, usageAt: 0, title: null, ttl: null }
  return (file) => {
    if (!file) return st
    if (file !== st.path) Object.assign(st, { path: file, offset: 0, rest: '', prompts: new Set() })
    let size
    try { size = fs.statSync(file).size } catch { return st }
    if (size < st.offset) Object.assign(st, { offset: 0, rest: '', prompts: new Set() })
    if (size === st.offset) return st
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - st.offset)
    fs.readSync(fd, buf, 0, buf.length, st.offset)
    fs.closeSync(fd)
    st.offset = size
    const text = st.rest + buf.toString('utf8')
    const lines = text.split('\n')
    st.rest = lines.pop() ?? ''
    const chunk = lines.join('\n')
    st.title = sessionTitleOf(chunk) ?? st.title
    st.ttl = cacheTtlOf(chunk) ?? st.ttl
    for (const line of lines) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.isSidechain) continue
      if (rec.type === 'user' && rec.promptId && !rec.isMeta) {
        const c = rec.message?.content
        const isPrompt = typeof c === 'string' || (Array.isArray(c) && !c.some((p) => p.type === 'tool_result'))
        const textPart = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p) => p.type === 'text')?.text : null
        if (isPrompt) {
          st.prompts.add(rec.promptId)
          if (textPart) st.lastPrompt = { text: textPart, at: Date.parse(rec.timestamp) || Date.now() }
        }
      }
      if (rec.type === 'assistant' && rec.message?.usage) {
        st.model = rec.message.model || st.model
        st.usage = rec.message.usage
        st.usageAt = Date.parse(rec.timestamp) || Date.now()
      }
    }
    return st
  }
}

function applyTranscript(board, st) {
  if (st.model && st.model !== '<synthetic>') board.model = st.model
  if (st.title) board.tabTitle = st.title
  if (st.prompts.size > board.turns) board.turns = st.prompts.size
  if (!board.prompt && st.lastPrompt) { board.prompt = clip(st.lastPrompt.text, 300); board.promptAt = st.lastPrompt.at }
  const u = st.usage
  if (u) {
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
    const window = windowOf(board.model, tokens)
    board.context = { percent: Math.round((tokens / window) * 100), tokens, window }
    if ((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 0) {
      board.cache = { at: st.usageAt, ttl: st.ttl ?? board.cache?.ttl ?? null }
    }
  }
}

function sampleMemory(owner, board, done) {
  if (process.platform !== 'win32') return done()
  const script = PROBE.replace('$root = ROOT', `$root = ${owner || 0}`)
  let out = ''
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', (d) => { out += d })
  child.on('error', () => done())
  child.on('close', (code) => {
    if (code !== 0) return done()
    const at = Date.now()
    const probe = parseProbe(out)
    done({ machine: parseMachine(out, at), probe, at })
  })
}

async function heartbeat(file, ownerArg) {
  const owner = Number(ownerArg) || null
  const read = transcriptReader()
  let memory = null // the newest probe result, applied on the next beat
  let probing = false
  const mine = (b) => b && !ownedByMod(b) && b.state !== 'ended' && b.hookHeartbeatPid === process.pid
  for (let beat = 0; ; beat++) {
    let board = load(file)
    if (!mine(board)) return
    if (owner && !alive(owner)) {
      setState(board, 'ended'); board.endReason = 'process gone'
      event(board, 'session', 'session ended (process gone)', Date.now())
      save(file, board); return
    }
    // Slow work first, then reload: a hook may have written meanwhile, and its write wins.
    let st = null
    let branch = null
    if (beat % SLOW_EVERY === 0) {
      try { st = read(board.transcriptPath) } catch {}
      branch = git(board.cwd, ['branch', '--show-current'])
      board = load(file)
      if (!mine(board)) return
    }
    if (st) applyTranscript(board, st)
    if (branch) board.branch = branch
    if (memory) {
      if (memory.machine) board.machine = memory.machine
      const m = memory.probe ? memoryOf(memory.probe, memory.at, board.memory ?? null) : null
      if (m) board.memory = m
      memory = null
    }
    if (beat % MEMORY_EVERY === 0 && !probing) {
      probing = true
      sampleMemory(owner, board, (r) => { probing = false; memory = r ?? null })
    }
    save(file, board)
    await new Promise((r) => setTimeout(r, BEAT_MS))
  }
}

if (process.argv[2] === '--heartbeat') {
  await heartbeat(process.argv[3], process.argv[4])
} else {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try { handle(JSON.parse(raw)) } catch {}
}
