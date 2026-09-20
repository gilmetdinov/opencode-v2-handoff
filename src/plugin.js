// opencode-v2-handoff — minimal deterministic end-of-session handoff for OpenCode v2.
//
// Writes a compact `LATEST.md` (goal / done / open / pointers / git / usage) when
// a session ends, so the next session starts with just enough context to continue
// — not the full transcript of the previous one.
//
// No LLM, no HTTP: everything comes from the v2 plugin context
// (`ctx.session.get` for title/tokens/cost, `ctx.session.context` for user
// prompts and tool calls) plus the git CLI for branch/status.
//
// Triggers:
//   - `session.execution.succeeded` / `.failed` / `.interrupted` / `session.idle`
//     → refresh LATEST (throttled, hash-deduped).
//   - `session.deleted` → full snapshot + per-session archive + rotation.
//
// Output location (priority):
//   1. plugin options `dir`
//   2. `<root>/.opencode/handoff.json` → `{ "dir": "./..." }`
//   3. default `<root>/docs/handoff/`
// If the handoff dir lives inside a git repo it's quietly added to `.git/info/exclude`.

import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const DEFAULT_DIR = "./docs/handoff"
const LATEST_NAME = "LATEST.md"
const KEEP_SESSIONS = 30
const THROTTLE_MS = 10 * 60 * 1000
const MAX_ZONES = 5
const MAX_COMMANDS = 3
const MAX_POINTERS = 5
const MAX_GIT_STATUS = 15
const MAX_LINES = 60

const lastWriteAt = new Map()
const lastHash = new Map()

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch {
    return null
  }
}

function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h)
}

function resolveDir(root, raw) {
  let p = String(raw || DEFAULT_DIR)
  if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2))
  if (!path.isAbsolute(p)) p = path.join(root, p)
  return path.normalize(p)
}

function readJsonOverride(root) {
  try {
    const f = path.join(root, ".opencode", "handoff.json")
    if (!existsSync(f)) return null
    const d = JSON.parse(readFileSync(f, "utf8"))
    return typeof d.dir === "string" && d.dir ? d.dir : null
  } catch {
    return null
  }
}

function gitRoot(cwd) {
  return sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"], cwd)
}

// branch + short status, capped. Non-git dirs get a marker.
export function gitSnapshot(cwd) {
  if (gitRoot(cwd) === null) return "n/a (not a git repo)"
  const branch = sh("git", ["-C", cwd, "branch", "--show-current"], cwd) || "?"
  const status = sh("git", ["-C", cwd, "status", "--short"], cwd) ?? ""
  const lines = status ? status.split("\n") : []
  const shown = lines.slice(0, MAX_GIT_STATUS)
  const tail = lines.length > MAX_GIT_STATUS ? `\n… (+${lines.length - MAX_GIT_STATUS} more)` : ""
  return `branch: ${branch}${lines.length ? `\n${shown.join("\n")}${tail}` : "\n(clean)"}`
}

// keep handoffs out of the working repo's `git status`
function excludeFromGit(dir, repoRoot) {
  try {
    const rel = path.relative(repoRoot, dir)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
    const excl = path.join(repoRoot, ".git", "info", "exclude")
    const cur = existsSync(excl) ? readFileSync(excl, "utf8") : ""
    const line = rel.endsWith("/") ? rel : rel + "/"
    if (!cur.split("\n").some((l) => l.trim() === line || l.trim() === rel)) {
      appendFileSync(excl, (cur.endsWith("\n") || cur === "" ? "" : "\n") + line + "\n")
    }
  } catch {
    // best effort
  }
}

export function relPath(root, abs) {
  if (!abs) return null
  const r = path.relative(root, abs)
  if (r && !r.startsWith("..") && !path.isAbsolute(r)) return r
  return abs
}

// --- Session semantics without an LLM: goal / done / usage ---

function normalizeMessages(ctxResult) {
  if (Array.isArray(ctxResult)) return ctxResult
  if (ctxResult && Array.isArray(ctxResult.data)) return ctxResult.data
  return []
}

// goal — session title (LLM-generated) or the first user prompt, one line.
export function collectGoal(info, messages) {
  if (info && typeof info.title === "string" && info.title.trim()) return info.title.trim()
  const firstUser = messages.find((m) => m.type === "user")
  if (firstUser && typeof firstUser.text === "string" && firstUser.text.trim()) {
    return firstUser.text.trim().replace(/\s+/g, " ").slice(0, 160)
  }
  return "(no goal)"
}

// done — key "zones" (directories of changed files, not individual files) plus
// significant shell actions. Hard ceiling, doesn't grow with the tool-call count.
const KEY_ACTIONS = [
  "git commit", "git push", "git merge", "git rebase", "git add", "git tag",
  "npm run", "npm test", "npm install", "npm ci", "npm publish", "pnpm", "yarn",
  "pytest", "cargo test", "cargo build", "cargo run", "go test", "go build",
  "make", "docker", "kubectl", "terraform", "ansible", "deploy", "pip install", "brew install",
]

function isSignificantCommand(cmd) {
  return KEY_ACTIONS.some((k) => cmd.includes(k))
}

function forEachToolCall(messages, fn) {
  for (const m of messages) {
    if (m.type !== "assistant") continue
    for (const p of m.content || []) {
      if (p.type !== "tool") continue
      if (p.state?.status !== "completed") continue
      fn(p)
    }
  }
}

// zones: directory → how many files were written/edited there
export function collectZones(root, messages) {
  const zones = new Map()
  forEachToolCall(messages, (p) => {
    if (p.name !== "write" && p.name !== "edit") return
    const rel = relPath(root, p.state?.input?.path || p.state?.input?.filePath)
    if (!rel) return
    const dir = path.dirname(rel)
    const key = dir === "." ? "(root)" : dir
    zones.set(key, (zones.get(key) || 0) + 1)
  })
  return [...zones.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ZONES)
}

// significant shell commands (cd/echo/cat/head noise filtered out)
export function collectCommands(messages) {
  const cmds = new Set()
  forEachToolCall(messages, (p) => {
    if (p.name !== "shell" && p.name !== "bash") return
    const cmd = typeof p.state?.input?.command === "string" ? p.state.input.command.replace(/\s+/g, " ").trim() : ""
    if (!cmd || !isSignificantCommand(cmd)) return
    cmds.add(cmd.slice(0, 80))
  })
  return [...cmds].slice(0, MAX_COMMANDS)
}

// concrete changed files (for pointers)
export function collectFiles(root, messages) {
  const files = new Set()
  forEachToolCall(messages, (p) => {
    if (p.name !== "write" && p.name !== "edit") return
    const rel = relPath(root, p.state?.input?.path || p.state?.input?.filePath)
    if (rel) files.add(rel)
  })
  return [...files]
}

export function collectUsage(info) {
  const t = info?.tokens || {}
  const cost = typeof info?.cost === "number" ? info.cost.toFixed(3) : null
  const model = info?.model ? `${info.model.providerID}/${info.model.id}` : null
  const parts = [`in ${t.input ?? 0}`, `out ${t.output ?? 0}`]
  if (t.reasoning) parts.push(`reasoning ${t.reasoning}`)
  if (cost) parts.push(`$${cost}`)
  if (model) parts.push(model)
  if (info?.outcome) parts.push(info.outcome)
  return parts.join(" | ")
}

export async function buildBody({ project, sessionID, root, handoffDir, ctx }) {
  let info = null
  let messages = []
  try {
    info = await ctx.session.get({ sessionID })
  } catch {
    // session may have vanished between the event and the read
  }
  try {
    messages = normalizeMessages(await ctx.session.context({ sessionID }))
  } catch {
    // best effort
  }

  const goal = collectGoal(info, messages)
  const zones = collectZones(root, messages)
  const commands = collectCommands(messages)
  const files = collectFiles(root, messages)
  const git = gitSnapshot(root)

  // done = zones (directories) + significant commands
  const done = [
    ...zones.map(([dir, n]) => `- ${dir}${n > 1 ? ` · ${n} files` : ""}`),
    ...commands.map((c) => `- run \`${c}\``),
  ]

  // open = uncommitted files from git status
  const open = parseOpen(root)

  // pointers = concrete files (from open, fallback to files touched)
  const pointers = (open.length ? open : files).slice(0, MAX_POINTERS)

  const usage = collectUsage(info)

  let body =
    `# Handoff: ${project} (auto)\n\n` +
    `- updated: ${new Date().toISOString()}\n` +
    `- session: ${sessionID}\n` +
    `- cwd: ${root}\n` +
    `- resume: \`opencode -s ${sessionID} -c\`\n\n` +
    `## goal\n${goal}\n`

  body += `\n## done\n` + (done.length ? done.join("\n") : "- (no file/command activity)")
  body += `\n\n## open\n` + (open.length ? open.map((o) => `- ${o}`).join("\n") : "(clean)")
  body += `\n\n## pointers\n` + (pointers.length ? pointers.map((p) => `- ${p}`).join("\n") : "- (none)")
  body += `\n\n## git\n${git}`
  body += `\n\n## usage\n${usage}\n`

  return trimBody(body)
}

// uncommitted files from `git status --short`, relative paths.
export function parseOpen(root) {
  if (gitRoot(root) === null) return []
  const status = sh("git", ["-C", root, "status", "--short"], root) ?? ""
  const out = []
  for (const line of status.split("\n")) {
    const f = line.slice(3).trim()
    if (f) out.push(f)
  }
  return out
}

export function trimBody(body) {
  const lines = body.split("\n")
  if (lines.length <= MAX_LINES) return body
  const keep = lines.slice(0, MAX_LINES - 2)
  return keep.join("\n") + "\n… (truncated)\n"
}

function rotateSessions(dir, project) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(project + "-") && f.endsWith(".md"))
      .map((f) => {
        try {
          return { f, m: statSync(path.join(dir, f)).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m)
    for (const { f } of files.slice(KEEP_SESSIONS)) {
      try {
        unlinkSync(path.join(dir, f))
      } catch {
        // skip
      }
    }
  } catch {
    // best effort
  }
}

function isFinalEvent(type) {
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted" ||
    type === "session.idle"
  )
}

async function handleEvent(ctx, event) {
  const type = event.type
  const isEnd = type === "session.deleted"
  if (!isFinalEvent(type) && !isEnd) return

  const sessionID = event.data?.sessionID ?? "unknown"
  const root = event.location?.directory ?? ctx.location?.directory
  if (typeof root !== "string" || root === "" || root === "/") return

  const optDir = ctx.options && typeof ctx.options.dir === "string" ? ctx.options.dir : null
  const dir = resolveDir(root, optDir ?? readJsonOverride(root) ?? DEFAULT_DIR)
  mkdirSync(dir, { recursive: true })
  const project = (path.basename(root) || "root").replace(/[^a-zA-Z0-9-_]+/g, "-").toLowerCase()

  const body = await buildBody({ project, sessionID, root, handoffDir: dir, ctx })
  const h = hash(body.replace(/^- updated: .*$/m, ""))

  if (!isEnd) {
    // refresh LATEST: throttle + skip unchanged
    const last = lastWriteAt.get(sessionID) || 0
    if (Date.now() - last < THROTTLE_MS && lastHash.get(sessionID) === h) return
    writeFileSync(path.join(dir, LATEST_NAME), body)
    lastWriteAt.set(sessionID, Date.now())
    lastHash.set(sessionID, h)
  } else {
    // session.deleted: archive + LATEST + rotation
    const day = new Date().toISOString().slice(0, 10)
    const short = String(sessionID).slice(0, 8)
    writeFileSync(path.join(dir, `${project}-${day}-${short}.md`), body)
    writeFileSync(path.join(dir, LATEST_NAME), body)
    rotateSessions(dir, project)
    lastWriteAt.delete(sessionID)
    lastHash.delete(sessionID)
  }

  const repo = gitRoot(root)
  if (repo) excludeFromGit(dir, repo)
}

export default {
  id: "handoff",
  setup(ctx) {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handleEvent(ctx, event)
          } catch {
            // never break the session because of the handoff
          }
        }
      } catch {
        // abort on plugin unload is expected
      }
    })()
    return () => controller.abort()
  },
}
