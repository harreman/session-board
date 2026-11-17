#!/usr/bin/env node
// Writes the session-board status file from ordinary Claude Code hooks, for clients that
// don't run the mod in hooks/ (the VS Code extension). Same file and schema as the mod, built
// with the mod's own helpers from hooks/lib.ts (Node 22.18+ runs TypeScript directly).
//
// Hook events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop,
// SubagentStart, SubagentStop, SessionEnd — each runs `node board-hook.mjs` with the hook
// payload on stdin. Calls made inside a subagent carry its agent_id: they're tagged with it, as
// the mod tags them, and don't move the main thread's state. Stop and SubagentStop list the
// session's background tasks and scheduled jobs, which settles agents, shells and crons.
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
  PROBE, QUIET_TOOLS, WAKEUP_ID, agentStatusOf, cacheTtlOf, clip, cronFired, cronToolDone, deriveState,
  freshBoard, memoryOf, parseMachine, parseProbe, pruneCrons, pruneShells, pushEvent, sessionTitleOf,
  shellReported, shellToolDone, slashCommand, summarize, toolLabel, trimAgents, workItemOf,
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

const event = (board, kind, text, t, agent) => pushEvent(board, { t, kind, text: clip(String(text ?? ''), 140), ...(agent ? { agent } : {}) })

function setState(board, state, t = Date.now()) {
  if (board.state !== state) { board.state = state; board.stateSince = t }
}

// The state as the mod derives it. A hook can't tell whether the main turn still runs while a
// subagent works, so hookMainRunning carries that from one event to the next.
function settle(board, t) {
  setState(board, deriveState(board, board.hookMainRunning === true), t)
}

const agentName = (board, agentId) => (agentId ? board.agents.find((a) => a.agentId === agentId)?.type ?? 'subagent' : undefined)

// A wait belongs to the thread that raised it; only that thread's next call ends it.
function clearWaiting(board, agentId) {
  if (board.waiting && (board.waiting.agentId ?? undefined) === agentId) board.waiting = null
}

function agentEnded(board, agent, status, t) {
  agent.status = status
  agent.endedAt ??= t
  event(board, 'agent', `${agent.type} ${status === 'done' ? 'finished' : 'stopped'} (${Math.round((t - agent.since) / 1000)}s)`, t)
}

// Stop and SubagentStop list what's in flight in the whole session: background tasks (shells,
// monitors, background subagents) and scheduled jobs. A foreground subagent is never listed, so
// an unlisted agent counts as over only at the main Stop, and only when no listed one could be
// its parent.
function reconcile(board, input, t, mainStopped) {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : null
  if (tasks) {
    const live = new Set(tasks.map((x) => x?.id))
    // A subagent's own shells: pruneShells drops them when it ends.
    board.shells = (board.shells ?? []).filter((s) => s.agentId || live.has(s.id))
    const listed = new Map(tasks.filter((x) => x?.type === 'subagent').map((x) => [x.id, x]))
    for (const a of board.agents) {
      if (a.status !== 'running' && a.status !== 'idle') continue
      const x = a.agentId ? listed.get(a.agentId) : null
      const status = x ? agentStatusOf(String(x.status)) : mainStopped && listed.size === 0 ? 'done' : a.status
      if (status === 'done' || status === 'failed') agentEnded(board, a, status, t)
      else a.status = status
    }
  }
  if (Array.isArray(input.session_crons)) {
    const old = new Map((board.crons ?? []).map((c) => [c.id, c]))
    // A ScheduleWakeup is listed as a one-shot under an id of its own; the board already keeps it.
    const dup = (j) => old.has(WAKEUP_ID) && j.recurring === false && !old.has(j.id)
    const jobs = input.session_crons.filter((j) => j?.id && !dup(j))
      .map((j) => ({ id: j.id, cron: j.schedule, humanSchedule: old.get(j.id)?.human ?? '', prompt: j.prompt, recurring: j.recurring }))
    cronToolDone(board, 'CronList', {}, { jobs }, t)
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
  if (input.transcript_path) board.transcriptPath = input.transcript_path
  board.agents ??= []
  board.crons ??= []
  board.shells ??= []
  // Set inside a subagent: its calls are tagged with it and leave the main thread's state alone.
  const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : undefined
  const who = agentName(board, agentId)

  switch (hookEvent) {
    case 'SessionStart':
      board.hookMainRunning = false
      event(board, 'session', `session ${input.source || 'started'}`, now)
      break
    case 'UserPromptSubmit': {
      const prompt = String(input.prompt || '')
      board.turns += 1; board.waiting = null; board.hookMainRunning = true
      const fired = cronFired(board, prompt, now)
      if (fired) event(board, 'turn', `${fired.human} fired`, now)
      if (/^\s*<(agent-message|task-notification)[\s>]/.test(prompt)) {
        // A background task or subagent reporting back, not the person: the prompt stays.
        const shell = shellReported(board, prompt)
        event(board, shell ? 'tool' : 'agent', shell ? `background done: ${shell.summary}` : 'report from a subagent', now)
        break
      }
      const slash = slashCommand(prompt)
      board.prompt = clip(prompt, 300); board.promptAt = now
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
      if (!agentId) board.hookMainRunning = true
      if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') {
        const detail = tool === 'ExitPlanMode' ? 'plan ready for review' : summarize(tool, ti)
        board.waiting = { kind: tool === 'ExitPlanMode' ? 'plan' : 'question', detail, tool, since: now, ...(agentId ? { agentId } : {}) }
        event(board, 'waiting', detail || tool, now, who)
        break
      }
      if (tool === 'Skill' && typeof ti.skill === 'string' && !agentId) {
        const args = typeof ti.args === 'string' ? ti.args : ''
        board.skill = { name: ti.skill, args: clip(args, 200), at: now }
        board.activeSkill = ti.skill
        board.workItem = workItemOf(args, true) ?? board.workItem
        event(board, 'skill', `${ti.skill} ${args}`, now)
      }
      clearWaiting(board, agentId)
      const rec = { id: input.tool_use_id || String(now), tool: toolLabel(tool), summary: summarize(tool, ti), ...(agentId ? { agentId } : {}), since: now }
      // One call per thread: hooks see every call start, but an end only for the tools PostToolUse matches.
      board.tools = [...(board.tools ?? []).filter((t) => (t.agentId ?? undefined) !== agentId), rec]
      if (agentId) {
        const agent = board.agents.find((a) => a.agentId === agentId)
        if (agent) {
          agent.lastTool = rec.summary ? `${rec.tool} · ${rec.summary}` : rec.tool
          if (agent.status === 'idle') agent.status = 'running'
        }
      }
      if (tool === 'Agent' || tool === 'Task') {
        const key = input.tool_use_id || String(now)
        const type = typeof ti.subagent_type === 'string' && ti.subagent_type ? ti.subagent_type : 'general-purpose'
        board.agents = [...board.agents.filter((a) => a.key !== key),
          { key, type, description: clip(String(ti.description ?? ''), 120), status: 'running', since: now }]
        event(board, 'agent', `${type} started: ${ti.description ?? ''}`, now, who)
      } else if (!QUIET_TOOLS.has(tool) && tool !== 'Skill') {
        event(board, 'tool', rec.summary ? `${rec.tool} · ${rec.summary}` : rec.tool, now, who)
      }
      break
    }
    case 'PostToolUse': {
      const tool = input.tool_name || 'tool'
      const ti = input.tool_input || {}
      const r = input.tool_response
      if (!agentId) board.hookMainRunning = true
      clearWaiting(board, agentId)
      board.tools = (board.tools ?? []).filter((t) => t.id !== input.tool_use_id)
      if (tool === 'Agent' || tool === 'Task') {
        const res = r && typeof r === 'object' ? r : {}
        const agent = board.agents.find((a) => a.key === input.tool_use_id) ?? board.agents.find((a) => res.agentId && a.agentId === res.agentId)
        if (agent) {
          if (typeof res.agentId === 'string') agent.agentId = res.agentId
          // A foreground agent returns 'completed'; a background one 'async_launched' and runs on.
          const status = agentStatusOf(String(res.status ?? 'completed'))
          if ((status === 'done' || status === 'failed') && (agent.status === 'running' || agent.status === 'idle')) agentEnded(board, agent, status, now)
        }
        break
      }
      const line = cronToolDone(board, tool, ti, r, now) ?? shellToolDone(board, tool, ti, r, input.tool_use_id || String(now), now, agentId)
      if (line) event(board, 'tool', line, now, who)
      break
    }
    case 'SubagentStart': {
      if (!agentId || board.agents.some((a) => a.agentId === agentId)) break
      const type = input.agent_type || 'subagent'
      // The Agent call that started it came first and knows its description; SubagentStart doesn't.
      const pending = board.agents.find((a) => !a.agentId && a.status === 'running' && a.type === type)
      if (pending) pending.agentId = agentId
      else {
        board.agents.push({ key: agentId, agentId, type, description: '', status: 'running', since: now })
        event(board, 'agent', `${type} started`, now)
      }
      break
    }
    case 'SubagentStop': {
      const agent = agentId ? board.agents.find((a) => a.agentId === agentId) : null
      if (agent && (agent.status === 'running' || agent.status === 'idle')) agentEnded(board, agent, 'done', now)
      if (agentId) board.tools = (board.tools ?? []).filter((t) => t.agentId !== agentId)
      clearWaiting(board, agentId)
      reconcile(board, input, now, false)
      break
    }
    case 'Notification':
      if (input.notification_type === 'permission_prompt' || /permission/i.test(input.message || '')) {
        board.waiting = { kind: 'question', detail: clip(String(input.message || ''), 200), since: now, ...(agentId ? { agentId } : {}) }
        event(board, 'waiting', input.message || 'permission needed', now, who)
      }
      break
    case 'Stop': {
      board.waiting = null
      board.hookMainRunning = false
      board.tools = (board.tools ?? []).filter((t) => t.agentId)
      reconcile(board, input, now, true)
      const secs = board.promptAt ? Math.round((now - board.promptAt) / 1000) : null
      event(board, 'turn', secs == null ? 'turn done' : `turn done in ${secs}s`, now)
      break
    }
    case 'SessionEnd':
      board.waiting = null
      board.tools = []
      board.hookMainRunning = false
      for (const a of board.agents) if (a.status === 'running' || a.status === 'idle') a.status = 'done'
      board.crons = [] // session-scoped jobs end with the session
      board.shells = []
      setState(board, 'ended', now)
      board.endReason = input.reason || 'ended'
      event(board, 'session', `session ended (${board.endReason})`, now)
      break
    default:
      return
  }
  if (board.state !== 'ended') settle(board, now)
  board.agents = trimAgents(board.agents)
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
    pruneCrons(board, Date.now())
    pruneShells(board, Date.now())
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
