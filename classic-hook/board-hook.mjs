#!/usr/bin/env node
// Writes the session-board status file from ordinary Claude Code hooks, for clients that
// don't run the mod in hooks/ (the VS Code extension). Same file, same schema, fewer fields:
// no memory samples, cost, context, agents or crons.
//
// Hook events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop,
// SessionEnd — each runs `node board-hook.mjs` with the hook payload on stdin.
// SessionStart also starts a detached heartbeat (`--heartbeat`), because the page treats a
// file whose updatedAt stops moving for 20 s as a dead session.
//
// Where the mod also runs, it owns the file. Every write here stamps hookWrittenAt equal to
// updatedAt; once updatedAt moves past that stamp, someone else is writing, and this hook
// and its heartbeat stay out of the way.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_EVENTS = 80
const HEARTBEAT_MS = 5_000

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
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const rootPath = root ? path.normalize(root) : null
  return {
    v: 1, sessionId: id, interactive: true, cwd,
    project: path.basename(rootPath || cwd),
    repo: rootPath ? { name: null, root: rootPath, remote: git(cwd, ['remote', 'get-url', 'origin']) } : null,
    branch: git(cwd, ['branch', '--show-current']),
    tabTitle: null, model: null,
    startedAt: now, updatedAt: now, state: 'idle', stateSince: now, waiting: null,
    prompt: null, promptAt: null, skill: null, activeSkill: null, workItem: null,
    prs: [], turns: 0, tools: [], agents: [], events: [],
    context: null, costUsd: null, cache: null, memory: null, machine: null,
    crons: [], shells: [], messages: [], done: null,
    client: 'classic-hook',
  }
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function event(board, kind, text, t = Date.now()) {
  board.events.push({ t, kind, text: clip(text, 140) })
  if (board.events.length > MAX_EVENTS) board.events.splice(0, board.events.length - MAX_EVENTS)
}

function setState(board, state, t = Date.now()) {
  if (board.state !== state) { board.state = state; board.stateSince = t }
}

function toolLabel(name, input = {}) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]} · ${mcp[2]}`
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.skill ?? ''
  return detail ? `${name} · ${detail}` : name
}

function workItemOf(text) {
  const m = /\bdeliver\b\D{0,20}?#?(\d{3,9})\b/i.exec(text || '')
  return m ? m[1] : null
}

function startHeartbeat(file, board) {
  if (board.hookHeartbeatPid && alive(board.hookHeartbeatPid)) return
  const owner = process.env.CLAUDE_PID ? `pid:${process.env.CLAUDE_PID}` : String(process.ppid)
  const child = spawn(process.execPath, [process.argv[1], '--heartbeat', file, owner],
    { detached: true, stdio: 'ignore', windowsHide: true })
  board.hookHeartbeatPid = child.pid
  child.unref()
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// The heartbeat lives as long as the session's claude process. Claude sets CLAUDE_PID for its
// children; without it, walk up from the hook's parent shell. That walk is a fallback only:
// it takes seconds on Windows, and the shell may already be gone by then.
function findClaudePid(start, done) {
  const procs = new Map()
  const walk = () => {
    for (let pid = start, i = 0; procs.has(pid) && i < 8; pid = procs.get(pid).ppid, i++) {
      if (/^claude/i.test(procs.get(pid).name)) return done(pid)
    }
    done(start)
  }
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }']]
    : ['ps', ['-A', '-o', 'pid=,ppid=,comm=']]
  let out = ''
  const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', (d) => { out += d })
  child.on('error', () => done(start))
  child.on('close', () => {
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, ...name] = line.trim().split(process.platform === 'win32' ? '\t' : /\s+/)
      if (pid) procs.set(Number(pid), { ppid: Number(ppid), name: path.basename(name.join(' ')) })
    }
    walk()
  })
}

async function heartbeat(file, ownerArg) {
  let owner = null
  if (ownerArg.startsWith('pid:')) owner = Number(ownerArg.slice(4))
  else findClaudePid(Number(ownerArg), (pid) => { owner = pid })
  for (;;) {
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
    const board = load(file)
    if (!board || ownedByMod(board) || board.state === 'ended') return
    if (board.hookHeartbeatPid !== process.pid) return
    if (owner !== null && !alive(owner)) {
      setState(board, 'ended'); board.endReason = 'process gone'; event(board, 'session', 'session ended (process gone)')
      save(file, board); return
    }
    save(file, board)
  }
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

  switch (hookEvent) {
    case 'SessionStart':
      event(board, 'session', `session ${input.source || 'started'}`, now)
      break
    case 'UserPromptSubmit': {
      const prompt = String(input.prompt || '')
      board.prompt = clip(prompt, 300); board.promptAt = now; board.turns += 1; board.waiting = null
      setState(board, 'running', now)
      event(board, 'prompt', prompt, now)
      const slash = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(prompt.trim())
      if (slash) {
        board.skill = { name: slash[1], args: clip(slash[2], 200), at: now }
        board.activeSkill = slash[1]
        event(board, 'skill', `${slash[1]} ${slash[2]}`, now)
      }
      board.workItem = workItemOf(prompt) ?? board.workItem
      break
    }
    case 'PreToolUse': {
      const name = input.tool_name || 'tool'
      const ti = input.tool_input || {}
      if (name === 'AskUserQuestion' || name === 'ExitPlanMode') {
        const detail = name === 'ExitPlanMode' ? 'plan ready for review' : ti.questions?.[0]?.question
        board.waiting = { kind: name === 'ExitPlanMode' ? 'plan' : 'question', detail: clip(detail, 200), tool: name, since: now }
        setState(board, 'waiting', now)
        event(board, 'waiting', detail || name, now)
        break
      }
      if (name === 'Skill' && ti.skill) {
        board.skill = { name: ti.skill, args: clip(ti.args, 200), at: now }
        board.activeSkill = ti.skill
        board.workItem = workItemOf(`${ti.skill} ${ti.args || ''}`) ?? board.workItem
      }
      board.waiting = null
      setState(board, 'running', now)
      event(board, 'tool', toolLabel(name, ti), now)
      break
    }
    case 'PostToolUse':
      board.waiting = null
      setState(board, 'running', now)
      break
    case 'Notification':
      if (input.notification_type === 'permission_prompt' || /permission/i.test(input.message || '')) {
        board.waiting = { kind: 'question', detail: clip(input.message, 200), since: now }
        setState(board, 'waiting', now)
        event(board, 'waiting', input.message || 'permission needed', now)
      }
      break
    case 'Stop': {
      board.waiting = null
      setState(board, 'idle', now)
      const secs = board.promptAt ? Math.round((now - board.promptAt) / 1000) : null
      event(board, 'turn', secs == null ? 'turn done' : `turn done in ${secs}s`, now)
      break
    }
    case 'SessionEnd':
      board.waiting = null
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

if (process.argv[2] === '--heartbeat') {
  await heartbeat(process.argv[3], process.argv[4])
} else {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try { handle(JSON.parse(raw)) } catch {}
}
