# Discovery

## Summary

Ten probes ran (7 code, 2 schema, 1 web). The spec is implementable as written, and most open questions now have hard answers. Key results:

- `wt` v0.77.0 is installed at `/opt/homebrew/bin/wt`. `wt list --format=json` emits a **schema-2 envelope** (`{schema, repo, collected, items[]}`), not a bare array. Per-item fields include `worktree.path`, `worktree.changes.{staged,modified,untracked,renamed,deleted,conflicted,diff}`, and a top-level `marker` string. A JSON Schema is published at `worktrunk.dev/schema/list-v2.json`.
- Create/switch/remove args are now known exactly: `wt switch -c <branch> [--base]`, `wt switch <branch> [--no-cd]`, `wt remove <branch> [-f] [-D] [--no-delete-branch] [--foreground]`. Global automation flags `-y/--yes`, `--no-hooks`, `--format json`, `-C <path>` are shared.
- Extension shape is confirmed: directory under `agent/extensions/<name>/index.ts` with a default-exported factory; `pi.registerTool` returns void; `execute` returns `{content, details}`; errors are returned as text, not thrown.
- No existing shared shell wrapper. `agent/extensions/lib/` holds only `jinja.ts`. The only precedents are private `git`/`tryGit` in `agent/extensions/verification/scope.ts:24-35` and `pi.exec(cmd, args, opts) -> {stdout, stderr, code, killed}`.
- No test in the repo stubs a binary on `PATH` or mocks `node:child_process`. PATH stubbing is a new-but-consistent pattern.
- Deleting `agent/skills/commit-message/SKILL.md` breaks exactly three snapshots: `commands.json:171-175`, `resources.json:8-12`, `system-prompt.txt:143-147`. Regenerate with `mise run snapshot`. The README layout table is generic and needs no row edit.
- No tool-name collisions: existing custom tools are `ask_user`, `sdd_save_plan`, `sdd_complete`, `sdd_verify`.
- Approval precedent: `await ctx.ui.confirm(title, message)` inside a tool's `execute`, guarded by `ctx.hasUI` (sdd/index.ts:487-495). `notify` is not an approval channel.
- Nothing may be written to tracked paths under `agent/` (drift gate). Untracked subdirs are allowlisted by `agent/.gitignore`, and `wt` already owns worktree bookkeeping, so no new state is needed.
- `gh` gotchas: `gh auth status` only has the `hosts` JSON field and exits 1 on auth issues; `gh pr checks` uses exit code 8 for pending; `gh pr create` can exit non-zero while still printing a PR URL; `gh pr update` manual page 404s (it is an alias of `gh pr edit`).

## Findings

### Worktrunk CLI contract for list/switch/remove

**Installed binary is wt v0.77.0; `wt list --format json` emits an envelope (schema 2), not a bare array. Parse `.items[]`.**

- `wt --version -> wt v0.77.0 (path /opt/homebrew/bin/wt)`
- `wt list --help: "JSON output: --format=json emits schema 2 by default: the envelope format below. Set [list] json-schema = 1 to retain the original bare-array format."`

**Per-item JSON shape: `{schema, repo{default_branch,forge{...}}, collected{ci,summary}, items:[{branch, remote, head{sha,short_sha,subject,committed_at}, worktree{path,main,current,previous,detached,locked,prunable,branch_mismatch,duplicate_branch,operation,changes}, default_branch{...}, upstream{...}, pr, checks, dev_server, summary, marker, vars, display{state,symbols,statusline,columns}}]}`. Dirty state = `worktree.changes.{staged,modified,untracked,renamed,deleted,conflicted}` plus `.diff{added,deleted}`. Agent marker is the top-level `marker` string, absent when unset.**

- `wt list --help: worktree object fields path, main, current, previous, detached, locked, prunable, branch_mismatch, duplicate_branch, operation, changes`
- `wt list --help changes object: staged, modified, untracked, renamed, deleted, conflicted, diff {added, deleted}`
- `wt list --help item fields table: "marker string  Branch marker from wt config state marker; absent when none is set"`
- `wt list --help Marker section: "it reads back as the item's marker field"`

**Create: `wt switch -c <branch>` (`-c, --create`), with `--base <BASE>`, `--no-hooks`, `--format json`, `-C <path>`, `-y`. If the branch already has a worktree, wt switches to it rather than erroring, so the extension must pre-check.**

- `wt switch --help: "Usage: wt switch [OPTIONS] [BRANCH] [-- <EXECUTE_ARGS>...]"`
- `wt switch --help: "-c, --create  Create a new branch"; "-b, --base <BASE>"; "--no-hooks  Skip hooks"; "--format <FORMAT> [text, json]"; "Global Options: -C <path>"`
- `wt switch --help: "If the branch already has a worktree, wt switch changes directories to it. Otherwise, it creates one"`
- `wt switch --help: "Branch doesn't exist - Use --create, or check wt list --branches; Path occupied - Another worktree is at the target path"`

**Switch: `wt switch <branch>`; use `--no-cd` for agent/CI use (skips directory change, hooks still run).**

- `wt switch --help: "wt switch feature  # Switch to worktree"; "--no-cd  Skip directory change after switching ... Useful when hooks handle navigation ... or for CI/automation"`
- `wt switch --help: "--format <FORMAT> ... JSON prints structured result to stdout. Designed for tool integration (e.g., Claude Code WorktreeCreate hooks)."`

**Remove: `wt remove <branch>` (defaults to current). Two separate force flags: `-f/--force` for a dirty worktree, `-D/--force-delete` for an unmerged branch. `--no-delete-branch` keeps the branch. `--foreground` blocks (removal is background by default).**

- `wt remove --help: "-f, --force  Force worktree removal ... Without this flag, removal fails if the worktree has any uncommitted changes."`
- `wt remove --help: "Force flags: --force (-f) Worktree | --force-delete (-D) Branch"; table "wt remove feature --force -D  # Both"`
- `wt remove --help: "--no-delete-branch Keep branch after removal"; "--foreground Run removal in foreground (block until complete)"`
- `wt remove --help: "JSON output: --format=json prints one object per removal to stdout: {kind, branch, path, branch_outcome, branch_checked_out_at}"`

**Status for the invoked repo: `wt list --format=json`, then select the item with `worktree.current == true`. `wt list statusline` is a separate single-line subcommand.**

- `wt list --help examples: "wt list --format=json | jq -r '.items[] | select(.worktree.current) | .worktree.path'"`
- `wt list --help Commands: "statusline  Single-line status for the current worktree"`

**All wt subcommands share automation/global flags: `-y/--yes`, `--no-hooks`, `--format json`, `-C <path>`, `--config-set <toml>`, `-v`.**

- `wt switch --help / wt remove --help: "Automation: --no-hooks Skip hooks; --format <FORMAT> [text, json]"; "Global Options: -C <path> Working directory for this command; --config-set <toml>"; "-y, --yes Skip approval prompts"`

**A published JSON Schema for the list envelope exists.**

- `wt list --help: "A JSON Schema for the envelope is published at worktrunk.dev/schema/list-v2.json"`

### Extension discovery + tool registration shape

**A new extension is a directory under `agent/extensions/<name>/` with a single default-exported factory taking `(pi: ExtensionAPI, options = {})`; no `settings.json` entry needed.**

- `README.md:28 - agent/extensions/<name>/index.ts | extensions, loaded with jiti (no build step)`
- `agent/extensions/verification/index.ts:59 - export default function (pi: ExtensionAPI, options: VerificationOptions = {})`
- `agent/extensions/ask-user/index.ts:49 - export default function (pi: ExtensionAPI)`
- `agent/settings.json - only packages/theme/model keys, no extension listing`

**`pi.registerTool(def)` returns void; it takes a `ToolDefinition` with name, label, description, optional `promptSnippet` and `promptGuidelines`, a TypeBox `parameters` schema, and an async `execute`.**

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1019 - registerTool<TParams, TDetails, TState>(tool: ToolDefinition<...>): void`
- `.../types.d.ts:345-373 - ToolDefinition fields incl. promptSnippet?: string (:353), promptGuidelines?: string[] (:355), parameters: TParams (:357), execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> (:373)`
- `agent/extensions/ask-user/index.ts:50-64 - registerTool with name/label/description/promptSnippet/promptGuidelines/parameters`

**`execute` must resolve to `AgentToolResult`: `{ content: (TextContent|ImageContent)[], details: T, usage?, terminate? }`. Repo convention is a local `text()` helper.**

- `.../@earendil-works/pi-agent-core/dist/types.d.ts (Final or partial result produced by a tool): content, details, usage?, terminate?`
- `agent/extensions/sdd/index.ts:368 - const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} })`
- `agent/extensions/ask-user/index.ts:100-104 - final return { content: [{ type: 'text', text: formatAnswers(...) }], details: { questions, answers } }`

**Error convention is error-as-text, not throwing.**

- `agent/extensions/ask-user/index.ts:88-90 - catch -> content: [{ type: 'text', text: `Error: ${(error as Error).message}` }]`
- `agent/extensions/ask-user/index.ts:73-82 - no-UI case returns `Error: no interactive UI; ...` as a normal result`
- `agent/extensions/sdd/index.ts:372 - if (!state) return text('Unknown feature "..."')`
- `agent/extensions/verification/index.ts:44-47 - checkAgentRegistry returns string | null, a clear error string rather than a throw`

**`ctx.hasUI` gates interactive prompting; `ctx.ui.notify(message, 'error'|'info')` is out-of-band UI, not a tool result channel.**

- `agent/extensions/ask-user/index.ts:73 - if (!ctx.hasUI)`
- `agent/extensions/sdd/index.ts:345-352 - ctx.ui.notify(..., 'info')`
- `agent/extensions/verification/index.ts:65-67 - catch -> ctx.ui.notify(`/verify: ${...message}`, 'error')`

**The registration factory body does no prerequisite check at load time; the verification check is a helper called inside the handler.**

- `agent/extensions/verification/index.ts:44-57 - checkAgentRegistry(cwd): string | null`
- `agent/extensions/verification/index.ts:59-68 - default export registers renderer + command, wraps handleVerify in try/catch`

**`promptSnippet` is required in practice: without it the tool is omitted from the "Available tools" system-prompt section.** `promptGuidelines` bullets are appended to the Guidelines section. Both matter because `tests/snapshots/system-prompt.txt` is snapshot-tested.

- `.../types.d.ts:352-353` and `:354-355` (probe notes this directly)

### Existing exec/git helper and a shared lib module

**The only existing shelling-out helper is private to the verification extension: module-local `git(cwd, args)` and `tryGit(cwd, args)` wrapping `execFileSync` with an args array. Not exported, not reusable as-is.**

- `agent/extensions/verification/scope.ts:1-3 (import { execFileSync } from 'node:child_process')`
- `agent/extensions/verification/scope.ts:24-28 (function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim() })`
- `agent/extensions/verification/scope.ts:30-35 (tryGit try/catch -> string | undefined, used by isGitRepo, detectBase, untrackedFiles)`

**`agent/extensions/lib/` exists but hosts only a template helper (`jinja.ts`). No shell wrapper yet, so the shared exec module is new.**

- `ls agent/extensions/lib -> jinja.ts only`
- `agent/extensions/lib/jinja.ts:1-19 (templatePath/renderTemplate, throw new Error('cannot read template ...') error style worth mirroring)`
- `agent/extensions/ contains ask-user, lib, protected-paths, sdd, verification`

**The host provides an async exec with `{stdout, stderr, code, killed}` plus `signal`/`timeout`/`cwd`; `pi.exec` is available on the extension API.**

- `node_modules/@earendil-works/pi-coding-agent/dist/core/exec.d.ts:18-28 (interface ExecResult { stdout; stderr; code; killed }, execCommand(command, args, cwd, options?))`
- `.../types.d.ts:1068 (exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>)`
- `hooks/pre/worktrunk.ts:14-21 (await pi.exec('wt', ['config','state','marker', ...args], { cwd: ctx.cwd }))`

**Recommended lib surface: `run(cmd, args, {cwd, signal, timeout, env, input?})` -> `{ok, stdout, stderr, code}` over args arrays, plus `tryRun` (-> undefined on failure), ENOENT -> "wt/gh not found" detection, and thin `git`/`gh`/`wt` wrappers. `ok = code === 0` maps to pi's `code` field, so it works over both `node:child_process` and `pi.exec`.**

- `spec constraint: 'returns { ok, stdout, stderr }'`
- `spec: 'Any git, wt or gh failure surfaces the command's stderr'`
- `agent/extensions/verification/scope.ts:30-35 for the tryGit -> undefined fallback precedent`
- `agent/extensions/ask-user/index.ts:88-95 as the error-surfacing reference from the spec`

**Tests already have an exec convention to copy: `git(cwd, args)` via `execFileSync` with `-c commit.gpgsign=false`, plus `mkdtempSync` isolation.**

- `tests/helpers.ts:1 (import { execFileSync } from 'node:child_process')`
- `tests/helpers.ts:51-53 (export function git(cwd, args) { return execFileSync('git', ['-c','commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim() })`
- `tests/helpers.ts:14-35 (isolate() using mkdtempSync, env override + restore)`

### Test harness conventions for PATH stubbing

**Temp git repos: `helpers.ts` exports `git(cwd, args)` via `execFileSync` with an arg array and gpg disabled; per-test `tmp()` uses `mkdtempSync(join(tmpdir(),'verify-'))`.**

- `tests/helpers.ts:53-55`
- `tests/verification.test.ts:18-19`
- `tests/verification.test.ts:22-26 (initRepo: git init -b main + commit --allow-empty)`
- `tests/verification.test.ts:28-33 (commitFile writes, git add, git commit)`

**Extensions are loaded by importing the default export and calling `register()` against a hand-rolled fake ExtensionAPI; tools are captured in an array and executed as `tool.execute('id', params, undefined, undefined, ctx)`.**

- `tests/verification.test.ts:9 (import register from '../agent/extensions/verification/index.ts')`
- `tests/verification.test.ts:532 (register(pi))`
- `tests/ask-user.test.ts:13`
- `tests/ask-user.test.ts:72-74 (fake pi with registerTool: tool => tools.push(tool.name))`
- `tests/ask-user.test.ts:280 (await tool.execute('id', params, undefined, undefined, ctx))`
- `tests/ask-user.test.ts:286 (asMock<ExtensionContext>({...ctx, hasUI: false}))`

**Env manipulation precedent exists, but only for HOME/PI_OFFLINE. There is no PATH-stubbing helper.**

- `tests/helpers.ts:15-33 (isolate(): mkdtempSync 'pi-harness-', sets HOME and PI_OFFLINE, returns restore)`
- `rg 'process.env.PATH' tests -> no matches in tests/*.ts (only tests/smoke.test.ts:26 asserts pi on PATH)`

**No test uses `vi.mock` of node:child_process, and `rg 'vi.mock|mock(' tests` returns nothing. PATH stubbing is a new-but-consistent pattern.**

- `rg 'vi.mock|mock\\(' tests -> no matches`
- `tests/smoke.test.ts:1-2 (real execFileSync/spawn used, no mocking)`

**Other env-var suites set `process.env` directly with manual cleanup in-file, so a per-file PATH stub with beforeEach/afterEach restore fits existing style.**

- `tests/mise-skill.test.ts:31-37 (mkdtempSync + per-case run)`
- `tests/sdd.test.ts:50 (const tmp = () => mkdtempSync(join(tmpdir(),'sdd-')))`

### Snapshot and drift blast radius of deleting the skill

**`commands.json` loses one 5-line object for `skill:commit-message` (lines 171-175).**

- `tests/snapshots/commands.json:171-175: {"name":"skill:commit-message","source":"skill","scope":"user","path":"<REPO>/agent/skills/commit-message/SKILL.md"}`

**`resources.json` loses one 4-line skills entry (lines 8-12).**

- `tests/snapshots/resources.json:8-12: {"name":"commit-message","path":"<REPO>/agent/skills/commit-message/SKILL.md","modelInvocable":true}`

**`system-prompt.txt` loses the commit-message `<skill>` block (lines 143-147).**

- `tests/snapshots/system-prompt.txt:144-146: <name>commit-message</name> ... <location><REPO>/agent/skills/commit-message/SKILL.md</location>`

**Regeneration command is `mise run snapshot` (`UPDATE_SNAPSHOTS=1` vitest over the files matched by `rg -l matchSnapshot`).**

- `mise.toml:42-46: [tasks.snapshot] env = { UPDATE_SNAPSHOTS = "1" }, run = 'npx vitest run $(rg -l matchSnapshot tests -g "*.test.ts" ...)'`
- `README.md:48: "After an intended change, run mise run snapshot and commit the diff."`
- `README.md:61: "4. Run mise run snapshot and commit."`

**README layout table needs no row edit; it is generic and stays truthful.**

- `README.md:26: | agent/skills/<name>/SKILL.md | skills, also callable as /skill:<name> |`
- `README.md:28: | agent/extensions/<name>/index.ts | extensions, loaded with jiti (no build step) |`

**No hardcoded skill list elsewhere references commit-message, so only the three snapshots break.**

- `rg -n "commit-message" tests/ README.md mise.toml returns only commands.json:171,174; resources.json:9,10; system-prompt.txt:144,146`
- `tests/mise-skill.test.ts:10-11 only pins the mise skill, unrelated`

**The drift gate is a runtime-write check only; a committed deletion in git does not trip it.**

- `mise.toml:54-58: [tasks.drift] run = 'out=$(git status --porcelain -- agent/); [ -z "$out" ] || ...'`
- `mise.toml:66-68: [tasks.check] = typecheck, lint, format:check, test, drift`

**New git tool names do not collide with any snapshot entry.**

- `Assumption listed in spec; snapshots under tests/snapshots contain no worktree/gh/commit tool entries`

### Tool name collisions and prompt-snippet budget

**Existing custom tool names: `ask_user`, `sdd_save_plan`, `sdd_complete`, `sdd_verify`. No worktree/gh/commit exists, so no collision.**

- `agent/extensions/ask-user/index.ts:51`
- `agent/extensions/sdd/index.ts:61-64`
- `agent/extensions/sdd/index.ts:354,389,444`
- `tests/snapshots/system-prompt.txt:8-12`

**Only two extensions register tools (ask-user, sdd); verification and protected-paths register none. `agent/extensions/lib/` already exists with `jinja.ts`.**

- `rg registerTool agent/extensions -> only ask-user:50 and sdd:353,388,439`
- `ls agent/extensions -> ask-user, lib, protected-paths, sdd, verification`
- `ls agent/extensions/lib -> jinja.ts`

**Prompt cost per tool is one snippet line; `promptGuidelines` render as a separate guidelines block (3 lines for `ask_user`). Total system prompt is 15490 bytes.**

- `tests/snapshots/system-prompt.txt:8-12`
- `tests/snapshots/system-prompt.txt:38-39`
- `agent/extensions/ask-user/index.ts:55-61`
- `tests/snapshots/system-prompt.txt:3-27 (tools block)`
- `wc -c tests/snapshots/system-prompt.txt -> 15490`

**The system-prompt snapshot lists tool names and snippets, not descriptions, so long descriptions are prompt-free. Moving the skill removes its `<available_skills>` block.**

- `tests/snapshots/system-prompt.txt:150 (skill description block)`
- `tests/snapshots/resources.json:9-10`

**Host tools also present in the prompt (for collision awareness): read, bash, edit, write, memory\_*, skill_manage, session_search, memory_search, workflow, workflow_control, web_search, source_check, fetch_content, get_search_content, web_enable.**

- `tests/snapshots/system-prompt.txt:3-27`

### Toolchain and gates that must pass

**Gate chain is `mise run check` = typecheck, lint, format:check, test, drift, in that order.**

- `mise.toml:52-56 [tasks.check] run = [{ task = "typecheck" }, { task = "lint" }, { task = "format:check" }, { task = "test" }, { task = "drift" }]`

**typecheck = `npx tsc --noEmit` over `agent/extensions/**/*.ts` and `tests/**/*.ts` only; `hooks/` is NOT typechecked.**

- `mise.toml:9-13 [tasks.typecheck] run = "npx tsc --noEmit"`
- `tsconfig.json last line: "include": ["agent/extensions/**/*.ts", "tests/**/*.ts"]`

**Hard compiler constraints: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noFallthroughCasesInSwitch, verbatimModuleSyntax (type-only imports need `import type`), erasableSyntaxOnly (no enums/namespaces/parameter properties), allowImportingTsExtensions, module/moduleResolution nodenext, target es2024, types:["node"].**

- `tsconfig.json:3-17`

**ESM requirement: `package.json` `"type": "module"`, engines node >=22.19.0, mise pins node 24 and pi 0.87.0; relative imports must carry `.ts`.**

- `package.json:3, :21`
- `tsconfig.json "allowImportingTsExtensions": true, "module": "nodenext"`
- `agent/extensions/sdd/index.ts:6-10 imports '../ask-user/interview.ts', './memory.ts' with .ts extensions`

**lint = `npx oxlint --config .oxlintrc.jsonc`; plugins eslint, typescript, unicorn, oxc, import, vitest, node; only the `correctness` category as error. Extra rules: `vitest/no-import-node-test`, `vitest/expect-expect`, `import/no-duplicates`, `import/no-unassigned-import`, `typescript/no-explicit-any`, `typescript/no-unused-vars`. Default plugin set is replaced.**

- `mise.toml:20-25 [tasks.lint]`
- `.oxlintrc.jsonc:4-19`

**oxlint ignores node_modules, dist, .pi; it does lint `agent/` and `tests/`.**

- `.oxlintrc.jsonc:20 "ignorePatterns": ["node_modules", "dist", ".pi"]`

**format:check = `npx oxfmt --check .` over the whole repo tree; `mise run format` rewrites in place. New files must be oxfmt-formatted.**

- `mise.toml:32-40 [tasks.format] run 'npx oxfmt --write .', [tasks."format:check"] run 'npx oxfmt --check .'`

**test = `npx vitest run` with no vitest.config file present, so vitest defaults apply. Snapshots regenerate via the separate `mise run snapshot` task.**

- `mise.toml:14-18 [tasks.test] run = "npx vitest run"`
- `mise.toml:41-45 [tasks.snapshot] env = { UPDATE_SNAPSHOTS = "1" }, run 'npx vitest run $(rg -l matchSnapshot tests -g "*.test.ts" | tr "\n" " ")'`

**drift = `git status --porcelain -- agent/` must be empty; only agent/ is checked, not hooks/ or tests/.**

- `mise.toml:46-51 [tasks.drift] run 'out=$(git status --porcelain -- agent/); [ -z "$out" ] || { echo "$out" >&2; exit 1; }'`

**Agent-facing deps come from pi packages: `@earendil-works/pi-coding-agent` 0.87.0 and `@quintinshaw/pi-dynamic-workflows`. `typebox` is used by sdd but is not a direct dependency, so relying on it is fragile.**

- `package.json:5-19`
- `agent/extensions/sdd/index.ts:3 import { Type } from 'typebox'`

**A shared-module directory already exists at `agent/extensions/lib/` (jinja.ts), so the new exec wrapper is a new file beside an existing shared lib, not a new barrel. No barrel file exists in the repo today.**

- `ls agent/extensions/lib -> jinja.ts`
- `agent/extensions/sdd/index.ts imports specific files, not a lib index`

### Runtime-write drift hazard for worktree bookkeeping

**Nothing tracked under `agent/` may be written at runtime; the drift gate fails the build on any change.**

- `mise.toml:54-57 [tasks.drift] runs out=$(git status --porcelain -- agent/); [ -z "$out" ] || exit 1`
- `mise.toml:65-66 tasks.check runs typecheck, lint, format:check, test, drift`
- `mise.toml:59-62 [tasks.reset] exists precisely because pi mutates tracked config: "Discard runtime writes pi made to tracked config" (git checkout -- agent/)`

**`agent/` is a mixed config+data dir, but untracked data is allowlisted by `agent/.gitignore` so runtime writes are invisible to git status and therefore safe.**

- `agent/.gitignore:2 * ignores everything, with a tracked allowlist (!skills/**, !extensions/**, !prompts/**, !agents/**, !themes/**, !settings.json, !models.json, !keybindings.json)`
- `git check-ignore -v agent/auth.json agent/sessions agent/models-store.json agent/projects-memory -> agent/.gitignore:2 for all four`
- `agent/.gitignore:1 comment: "Allowlist: pi writes state (auth.json, trust.json, sessions/, bin/, npm/, ...) here."`

**The sanctioned precedent for extension state is a gitignored subdir under `<cwd>/agent`, created with `mkdirSync`/`writeFileSync`.**

- `agent/extensions/sdd/store.ts:28 return join(cwd, CONFIG_DIR_NAME, 'sdd') (CONFIG_DIR_NAME imported from @earendil-works/pi-coding-agent, store.ts:4)`
- `agent/extensions/sdd/store.ts:33-35 featureDir -> join(sddRoot(cwd), slug)`
- `agent/extensions/sdd/store.ts:56,62 writeFileSync/mkdirSync into that dir`
- `rg 'writeFile|mkdir' agent/ shows sdd/store.ts as the only runtime writer`

**Worktrunk bookkeeping is already owned by `wt`, and the existing hook only shells out to it, writing nothing itself.**

- `hooks/pre/worktrunk.ts:14-21 await pi.exec('wt', ['config','state','marker', ...args], { cwd: ctx.cwd })`
- `hooks/pre/worktrunk.ts:22-35 markers set/cleared on agent_start, agent_end, session_shutdown; errors swallowed`

**Answer: no new state dir is needed. If one were, mirror sdd: an untracked subdir under the pi config dir. Do not add tracked files and do not mutate `agent/settings.json`.**

### gh CLI output formats for the read-only ops

**`gh auth status` has only one JSON field, `hosts`, and exits 1 on any auth issue, writing issues to stderr. With `--json` it exits 0 regardless of auth issues unless a fatal error.**

- `https://cli.github.com/manual/gh_auth_status - "If an account on any host ... has authentication issues, the command will exit with 1 and output to stderr. Note that when using the --json option, the command will always exit with zero regardless of any authentication issues, unless there is a fatal error."`
- `https://cli.github.com/manual/gh_auth_status - "### JSON Fields \n\nhosts"`
- `Local: gh auth status --json on gh 2.101.0 prints 'Specify one or more comma-separated fields for --json: hosts' -> confirms hosts is the only field.`

**Human (non-JSON) `gh auth status` is the right logged-out detection, since exit code is the signal.**

- `https://cli.github.com/manual/gh_auth_status - "For each host, the authentication state of each known account is tested and any issues are included in the output."`
- `https://cli.github.com/manual/gh_auth_status - example gh auth status --json hosts --jq '.hosts | add' (hosts is a list per hostname, flattenable).`

**`gh pr view --json` supports a wide field set. Useful read-only picks: number, title, body, state, isDraft, url, headRefName, baseRefName, mergeable, mergeStateStatus, reviewDecision, statusCheckRollup, createdAt, updatedAt, author, labels, files, commits, reviews.**

- `https://cli.github.com/manual/gh_pr_view - "### JSON Fields \n\n additions, assignees, author, autoMergeRequest, baseRefName, baseRefOid, body, changedFiles, closed, closedAt, closingIssuesReferences, comments, commits, createdAt, deletions, files, fullDatabaseId, headRefName, headRefOid, headRepository, headRepositoryOwner, id, isCrossRepository, isDraft, labels, latestReviews, maintainerCanModify, mergeCommit, mergeStateStatus, mergeable, mergedAt, mergedBy, milestone, number, potentialMergeCommit, projectCards, projectItems, reactionGroups, reviewDecision, reviewRequests, reviews, state, statusCheckRollup, title, updatedAt, url"`
- `https://cli.github.com/manual/gh_pr_view - "Without an argument, the pull request that belongs to the current branch is displayed."`

**`gh pr checks --json` fields are bucket, completedAt, description, event, link, name, startedAt, state, workflow. `bucket` only exists with `--json`. There is an extra exit code 8 for pending checks, so non-zero does not necessarily mean failure.**

- `https://cli.github.com/manual/gh_pr_checks - "When the --json flag is used, it includes a bucket field, which categorizes the state field into pass, fail, pending, skipping, or cancel."`
- `https://cli.github.com/manual/gh_pr_checks - "Additional exit codes: 8: Checks pending"`
- `https://cli.github.com/manual/gh_pr_checks - "### JSON Fields \n\n bucket, completedAt, description, event, link, name, startedAt, state, workflow"`

**`gh repo view --json` offers a very large field set; practical subset: nameWithOwner, description, url, defaultBranchRef, isPrivate, isFork, parent, viewerPermission, stargazerCount, primaryLanguage, pushedAt, createdAt, updatedAt, visibility.**

- `https://cli.github.com/manual/gh_repo_view - "### JSON Fields \n\n archivedAt, assignableUsers, ... defaultBranchRef, ... isFork, ... nameWithOwner, ... parent, primaryLanguage, ... pushedAt, ... stargazerCount, ... url, ... viewerPermission, visibility, watchers"`
- `https://cli.github.com/manual/gh_repo_view - "With no argument, the repository for the current directory is displayed."`

**`gh pr create` prints the new PR URL to stdout on success, is non-interactive only when `--title` and (`--body` or `--body-file`) are given, and can exit non-zero while still printing a URL. `--dry-run` prints details without creating.**

- `https://cli.github.com/manual/gh_pr_create - "Upon success, the URL of the created pull request will be printed."`
- `https://cli.github.com/manual/gh_pr_create - "Use --title and --body to skip this, or use --fill to autofill these values from git commits."`
- `https://cli.github.com/manual/gh_pr_create - "If some attachments upload and others fail, the pull request is still created with the ones that succeeded. The command then exits with a non-zero status, but the new pull request's URL is still printed to stdout."`
- `https://cli.github.com/manual/gh_pr_create - "--dry-run Print details instead of creating the PR. May still push git changes."`
- `https://cli.github.com/manual/gh_pr_create - "-F, --body-file <file> Read body text from file (use "-" to read from standard input)"`

**`gh pr update` is an alias of `gh pr edit`; the manual page 404s, so the extension should target `gh pr edit` or the alias.**

- `https://cli.github.com/manual/gh_pr_update returned HTTP 404 Not Found`
- `https://cli.github.com/manual/gh_pr_create - "## ALIASES \n\ngh pr new" (same alias pattern used for edit/update)`

**Stderr surfacing: gh writes human-facing errors to stderr and returns non-zero; return gh's stderr verbatim, and do not treat non-zero alone as failure for `pr checks` (exit 8 = pending) or `pr create` (URL may still be on stdout).**

- `https://cli.github.com/manual/gh_auth_status - "the command will exit with 1 and output to stderr"`
- `https://cli.github.com/manual/gh_pr_checks - "Additional exit codes: 8: Checks pending"`
- `https://cli.github.com/manual/gh_pr_create - "The command then exits with a non-zero status, but the new pull request's URL is still printed to stdout."`
- `https://cli.github.com/manual/gh_pr_create - "When the current branch isn't fully pushed to a git remote, a prompt will ask where to push the branch ..." (prompt behaviour to avoid by passing --head/--title/--body)`

### Approval/prompt precedent for mutating tools

**There is a reusable in-tool approval primitive: `ctx.ui.confirm(title, message)` returns a `Promise<boolean>`, usable directly inside a tool's `execute`. sdd uses it to pause a mutating loop and returns a text result when declined.**

- `agent/extensions/sdd/index.ts:487`
- `agent/extensions/sdd/index.ts:488-495`

**The other confirm is in a command handler (ExtensionCommandContext), so the tool-level path is the sdd_verify round-cap one, not `implement()`.**

- `agent/extensions/sdd/index.ts:227`
- `agent/extensions/sdd/index.ts:232`

**`ctx.hasUI` is the guard; sdd notify's an error when absent, ask_user returns an Error text result instead of throwing.**

- `agent/extensions/ask-user/index.ts:71-79`
- `agent/extensions/sdd/index.ts:276`
- `agent/extensions/sdd/progress.ts:113`

**`ctx.ui.notify(msg, level)` is fire-and-forget (info/warning/error) and is not an approval channel.**

- `agent/extensions/sdd/index.ts:345`
- `agent/extensions/protected-paths/index.ts:18`

**ask_user is the only other channel, and sdd's convention there is to hand the decision to the model and stop (tool-to-tool handshake).**

- `agent/extensions/sdd/index.ts:375`
- `agent/extensions/sdd/index.ts:493`

**No existing extension prompts for approval before a git/network mutation; the only git-related approval today is prose in the commit-message skill.**

- `agent/skills/commit-message/SKILL.md:11`

## Pre-answered questions

1. **`wt` passthrough vs closed operation set.** Closed set. wt exposes stable automation flags (`-y/--yes`, `--no-hooks`, `--format json`, `-C <path>`) and known per-op contracts (Evidence: "Automation: --no-hooks Skip hooks; --format <FORMAT> [text, json]"; "Global Options: -C <path> Working directory for this command; --config-set <toml>"; "-y, --yes Skip approval prompts"). A passthrough parameter would also need the worktree's ownership of layout and markers, which the spec forbids reimplementing.

2. **Should `commit` stage files itself, or stay scoped to staged content?** Stay scoped. `git()`/`tryGit()` precedent is read-only, and the spec's expected behaviour is "returns the staged diff plus the message rules" and "The `commit` tool with nothing staged reports that plainly instead of diffing an empty index" (Evidence: `agent/extensions/verification/scope.ts:24-35`; `spec: 'Any git, wt or gh failure surfaces the command's stderr'`).

3. **PR body: commit body verbatim or generated summary with commit list?** Generated summary with commit list. `gh pr create` already has `--fill` to autofill from git commits, and a generated body is what "builds a body from the local commits" in the spec means (Evidence: `https://cli.github.com/manual/gh_pr_create - "Use --title and --body to skip this, or use --fill to autofill these values from git commits."`).

4. **Should the message rules be hard-enforced or only stated in promptGuidelines?** State them in `promptGuidelines`. The base AgentTool doc says "Throw on failure instead of encoding errors in content", but every in-repo tool encodes guidance/errors in content, and the spec says the model writes the message and shows it (Evidence: `agent/extensions/ask-user/index.ts:88-90`; `agent/extensions/sdd/index.ts:368`). A type outside the set should be surfaced as guidance text, not an error. Enforcement can still be a pure, unit-tested validation function returning a hint string, matching the `checkAgentRegistry(cwd): string | null` precedent (`agent/extensions/verification/index.ts:44-47`).

5. **Does deleting the skill need a README note?** Yes for user-facing truth, not for the layout table. The table rows are generic and need no edit (Evidence: `README.md:26`, `README.md:28`), but the removal is user-visible: `commands.json:171-175`, `resources.json:8-12`, `system-prompt.txt:144-146` all name `/skill:commit-message`, and `README.md:48`/`README.md:61` tell users to regenerate snapshots after an intended change.

6. **Tool name collisions.** None. `worktree`, `gh`, `commit` are unused (Evidence: `rg registerTool agent/extensions -> only ask-user:50 and sdd:353,388,439`; `tests/snapshots/commands.json:171-175`).

7. **Prompt budget.** Cheap. One snippet line per tool, guidelines render as a separate block, descriptions are not in the snapshot; full prompt is 15490 bytes (Evidence: `tests/snapshots/system-prompt.txt:3-27`, `:38-39`; `wc -c -> 15490`).

8. **Where does the `gh` tool target `pr update`?** `gh pr edit` (the `gh pr update` manual 404s) (Evidence: `https://cli.github.com/manual/gh_pr_update returned HTTP 404 Not Found`).

## Remaining gaps

- `wt switch --format json` output fields are unknown; the help only says "structured result". Safer to re-derive state from `wt list --format=json` after switching (Evidence: `wt switch --help: "--format <FORMAT> ... JSON prints structured result to stdout. Designed for tool integration (e.g., Claude Code WorktreeCreate hooks)."`).
- Actual `items[]` output for a plain `wt list` (no `--full`) is unverified; the shape comes from wt's own `--help` docs, and no wt command was run against a real repo.
- `wt switch -c` behaviour on an existing branch (errors vs reuses worktree) was not tested. Pre-check `wt list --format=json` for a matching worktree.
- Exit codes and stderr text for a dirty-remove refusal were not observed. Surface wt stderr verbatim.
- `wt remove --format json` per-removal object fields are known from help (`{kind, branch, path, branch_outcome, branch_checked_out_at}`, with `branch_outcome` in `deleted|deferred|not_attempted|retained_unmerged|retained_checked_out|retained_raced|retained_failed`) but were not observed live. Note removal is background by default unless `--foreground`.
- `ctx.ui.confirm` has no type declaration found in node_modules; exact overloads and headless behaviour unverified. Only one in-tool usage exists (sdd round cap), and there is no precedent for a tool degrading gracefully when `ctx.hasUI` is false other than ask_user's error string.
- The spec's "model asks, then tool runs" approval flow has no repo precedent. Two viable patterns: `ctx.ui.confirm` inside execute (blocking, in-tool) or ask_user + stop (sdd's convention). The spec describes the former for the commit message and the latter for push/PR.
- No test stubs a binary on `PATH`; the design (temp bin dir, shell script, PATH prepend) has no in-repo precedent. No vitest config was found, so pool/env isolation and whether PATH mutation leaks across test files is unverified.
- `typebox` is imported by sdd but is not a direct dependency in package.json, so using it for new `parameters` schemas is fragile (Evidence: `agent/extensions/sdd/index.ts:3 import { Type } from 'typebox'`; `package.json:5-19`).
- No gate was actually run (read-only task), so the current pass/fail state of the tree is unconfirmed. `mise run check` must be run for real before shipping.
- oxfmt's exact formatting rules (line width, quote style, semicolons) were not read from a config; observed style is single quotes, no semicolons, trailing commas. `oxfmt --check .` runs over the whole repo.
- Whether `agent/extensions/verification/scope.ts` should be refactored onto the new lib is unresolved (spec says no rewrite of verification). Note `typebox` fragility and the `verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` strictness that new parsing code over `wt`'s JSON must satisfy.
- `git check-ignore` showed `agent/` is a config+data dir with an allowlist; `CONFIG_DIR_NAME` was assumed to be `agent` and not verified at runtime.
- Not checked: whether `tests/resources.test.ts` / `system-prompt.test.ts` hardcode skill counts or indices beyond `matchSnapshot`; whether discovery validates named exports alongside default; whether `ExtensionContext` passed to `execute` exposes `exec` or only `ExtensionContextActions` does.
- `gh` gaps: `gh pr edit` flags/JSON were not fetched; the per-account schema of `gh auth status --json hosts` is undocumented; no live commands were run; exit codes beyond 0/1 (e.g. 4 for no matching PR) are unstated.
- Open product question for `gh pr checks`: exit 8 means pending, not failure, so the tool must key off `bucket`/`state` rather than the exit code.

## Relevant files

**New (to create)**

- `agent/extensions/lib/exec.ts` - shared `run`/`tryRun` -> `{ok, stdout, stderr, code}`, arg arrays only
- `agent/extensions/git-worktree/index.ts` + pure parse/format module
- `agent/extensions/git-gh/index.ts` + pure arg-build/format module
- `agent/extensions/git-commit/index.ts` + pure message-rules module
- `tests/git-worktree.test.ts`, `tests/git-gh.test.ts`, `tests/git-commit.test.ts`

**To delete**

- `agent/skills/commit-message/SKILL.md` (its rules move to the `commit` tool's `promptGuidelines`; the only approval prose today lives at `agent/skills/commit-message/SKILL.md:11`)

**To regenerate**

- `tests/snapshots/commands.json` (drop lines 171-175)
- `tests/snapshots/resources.json` (drop lines 8-12)
- `tests/snapshots/system-prompt.txt` (drop lines 143-147, add 3 snippet lines + commit guidelines)
- Command: `mise run snapshot` (`mise.toml:42-46`)

**Read as precedent, not to be changed**

- `agent/extensions/verification/index.ts:44-68` (prereq check as `string | null`, registerEntryRenderer, try/catch)
- `agent/extensions/verification/scope.ts:1-35` (private `git`/`tryGit` with execFileSync arg arrays)
- `agent/extensions/ask-user/index.ts:49-104` (registerTool shape, `ctx.hasUI`, `Error: ...` text results)
- `agent/extensions/sdd/index.ts:345-395, 444-495` (`text()` helper, `ctx.ui.confirm` in-tool, ask_user+stop)
- `agent/extensions/sdd/store.ts:4, 28-62` (sanctioned untracked state dir)
- `agent/extensions/lib/jinja.ts:1-19` (error style in the lib dir)
- `hooks/pre/worktrunk.ts:14-35` (`pi.exec('wt', ['config','state','marker', ...])`)
- `agent/settings.json` (untouched; no extension listing)
- `agent/.gitignore:1-2` (allowlist that makes runtime state safe)

**Config and gates**

- `mise.toml:9-68` (typecheck, lint, format, test, snapshot, drift, check, reset)
- `tsconfig.json:3-17` + `include` (strict flags, nodenext, `.ts` imports)
- `.oxlintrc.jsonc:4-20`
- `package.json:3, 5-19, 21` (ESM, deps, node >=22.19.0)
- `README.md:26, 28, 48, 61` (layout table, snapshot workflow)

**Test harness**

- `tests/helpers.ts:1-55` (`isolate()`, `git()`)
- `tests/verification.test.ts:9, 18-33, 532`
- `tests/ask-user.test.ts:13, 72-74, 280, 286`
