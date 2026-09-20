import { test } from "node:test"
import assert from "node:assert/strict"
import {
  collectGoal,
  collectZones,
  collectCommands,
  collectFiles,
  collectUsage,
  trimBody,
  buildBody,
} from "../src/plugin.js"

const ROOT = "/proj"
const tool = (name, input) => ({ type: "tool", name, state: { status: "completed", input } })

const messages = [
  { type: "user", text: "add the auth feature" },
  {
    type: "assistant",
    content: [
      tool("write", { path: `${ROOT}/src/a.ts` }),
      tool("edit", { path: `${ROOT}/src/b.ts` }),
      tool("edit", { path: `${ROOT}/src/opencode/c.ts` }),
      tool("read", { path: `${ROOT}/src/readme.md` }),
      tool("shell", { command: "git commit -am 'feat: auth'" }),
      tool("shell", { command: "cd /proj && echo \"====\" && git status | head" }),
      tool("glob", { pattern: "**/*.ts" }),
    ],
  },
]

test("collectGoal prefers title, falls back to first user prompt", () => {
  assert.equal(collectGoal({ title: "Auth feature" }, messages), "Auth feature")
  assert.equal(collectGoal(null, messages), "add the auth feature")
  assert.equal(collectGoal(null, []), "(no goal)")
})

test("collectZones groups changed files by directory, sorted by count", () => {
  const zones = collectZones(ROOT, messages)
  assert.deepEqual(zones, [
    ["src", 2],
    ["src/opencode", 1],
  ])
})

test("collectCommands keeps significant actions, drops echo/cd noise", () => {
  const cmds = collectCommands(messages)
  assert.deepEqual(cmds, ["git commit -am 'feat: auth'"])
})

test("collectFiles returns only written/edited files", () => {
  const files = collectFiles(ROOT, messages).sort()
  assert.deepEqual(files, ["src/a.ts", "src/b.ts", "src/opencode/c.ts"])
})

test("collectUsage renders tokens/cost/model/outcome", () => {
  const u = collectUsage({
    tokens: { input: 100, output: 20, reasoning: 5 },
    cost: 0.001,
    model: { providerID: "p", id: "m" },
    outcome: "succeeded",
  })
  assert.equal(u, "in 100 | out 20 | reasoning 5 | $0.001 | p/m | succeeded")
})

test("trimBody caps total line count", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
  const out = trimBody(long)
  assert.ok(out.split("\n").length <= 61)
  assert.ok(out.includes("(truncated)"))
})

test("buildBody assembles the minimal LATEST with a mocked ctx", async () => {
  const ctx = {
    session: {
      get: async () => ({
        title: "Add auth",
        tokens: { input: 100, output: 20 },
        cost: 0.001,
        model: { providerID: "p", id: "m" },
        outcome: "succeeded",
      }),
      context: async () => messages,
    },
  }
  const body = await buildBody({ project: "proj", sessionID: "ses_x", root: ROOT, handoffDir: `${ROOT}/docs/handoff`, ctx })
  assert.match(body, /# Handoff: proj \(auto\)/)
  assert.match(body, /## goal\nAdd auth/)
  assert.match(body, /## done\n- src · 2 files/)
  assert.match(body, /## open\n/)
  assert.match(body, /## pointers\n/)
  assert.match(body, /## usage\nin 100 \| out 20/)
})
