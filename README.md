# opencode-v2-handoff

Minimal, deterministic end-of-session handoff for **OpenCode v2**.

When a session ends, the plugin writes a compact `LATEST.md` into your project
(`docs/handoff/LATEST.md` by default) capturing *why* the session existed, *what*
was done, and *where* to look next — so the next session resumes with just enough
context instead of re-reading the previous transcript.

> **Built for OpenCode v2 only.** This plugin targets the v2 plugin API
> (`{ id, setup(ctx) }`) and reads data from `ctx.session.get` /
> `ctx.session.context`. It does **not** work on OpenCode v1. There is a separate
> v1 package (`opencode-handoff`) by another author — this is the v2-native
> counterpart, with no LLM and no HTTP calls.

## What it writes

```markdown
# Handoff: my-project (auto)
- updated: 2026-09-20T22:09:37.121Z
- session: ses_...
- cwd: /path/to/project
- resume: `opencode -s ses_... -c`

## goal
create a file notes.md with the content hello handoff test

## done
- src · 2 files
- src/opencode
- docs
- run `git commit -am "feat: ..."`

## open
- src/a.ts
- src/b.ts

## pointers
- src/a.ts

## git
branch: main
 M src/a.ts
?? src/b.ts

## usage
in 7649 | out 99 | reasoning 159 | $0.000 | opencode-go/deepseek-v4-pro | succeeded
```

### Sections

- **goal** — session title (or the first user prompt): why this session existed.
- **done** — key **zones** (directories of changed files, grouped by frequency,
  not a flat file list) plus significant shell actions (`git commit`, `npm test`,
  `pytest`, …). Read/glob/echo noise is filtered out. Hard cap: 5 zones + 3 commands.
- **open** — uncommitted files from `git status --short` (what's still in flight).
- **pointers** — a few concrete files to open first.
- **git** — branch + short status (capped at 15 lines).
- **usage** — tokens in/out, cost, model, outcome — useful for model rotation.

## Install

Add it to `plugins` in your `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-v2-handoff"]
}
```

Or, with a custom output directory:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-v2-handoff",
      "options": { "dir": "./.opencode/handoff" }
    }
  ]
}
```

### Output location (priority)

1. plugin option `dir`
2. `<project>/.opencode/handoff.json` → `{ "dir": "./..." }`
3. default `<project>/docs/handoff/`

If the handoff directory lives inside a git repo, it's quietly added to
`.git/info/exclude` so it never shows up in `git status`.

## How it works

No LLM, no HTTP. On `session.execution.succeeded` / `.failed` / `.interrupted`
(or `session.idle`), the plugin reads the session via the plugin context and
builds the snapshot deterministically:

- `ctx.session.get({ sessionID })` → title, tokens, cost, model, outcome
- `ctx.session.context({ sessionID })` → user prompts + tool calls
- `git` CLI → branch + `status --short`

On `session.deleted` it additionally writes a per-session archive
(`<project>-<day>-<short>.md`) and rotates the archive down to the latest 30.

## Development

```sh
npm test
```

## License

MIT
