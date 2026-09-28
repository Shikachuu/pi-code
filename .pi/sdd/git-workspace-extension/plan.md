# Plan: Agentic git tools - Worktrunk workspaces, gh PRs, and commits

## Summary

Three new auto-discovered pi extensions under `agent/extensions/`, each owned by one tool registered with `pi.registerTool` (with `promptSnippet` and `promptGuidelines`), plus a shared exec helper in `agent/extensions/lib/exec.ts`:

- `git-worktree` - a `worktree` tool delegating `list | create | remove | status | switch` to `wt` (Worktrunk), never raw `git worktree`. Worktrunk already owns worktree layout, hooks and the agent markers that `hooks/pre/worktrunk.ts` sets.
- `git-gh` - a `gh` tool with read-only inspection (`auth`, `pr view`, `pr checks`, `repo view`) and the PR lifecycle (`pr create`, `pr update`), mutations gated behind in-tool `ctx.ui.confirm`.
- `git-commit` - a `commit` tool that reads the staged diff, returns it with the message rules from the deleted `commit-message` skill, validates messages with advisory hints, and commits directly (commits are non-destructive; no approval gate). `push: true` pushes only after `ctx.ui.confirm`.

The skill `agent/skills/commit-message/` is deleted so the rules have one owner; its behaviour moves to the `commit` tool's `promptGuidelines`. Snapshots are regenerated and `README.md` gains a note that `/skill:commit-message` is now the `commit` tool. `agent/settings.json` is untouched.

## Decisions

- `worktree` ops are a closed set, not a `wt` passthrough: validated against `list | create | remove | status | switch` - wt exposes stable automation flags and JSON, and a passthrough would invite reimplementing Worktrunk (spec non-goal).
- Parse `wt list --format=json` as the schema-2 envelope and read `.items[]`; dirty state comes from `worktree.changes`, the agent marker from the item's `marker` field. For `status`, select the item with `worktree.current == true`.
- After `create` (`wt switch -c <branch>`) and `switch` (`wt switch <branch> --no-cd`), re-derive state from a follow-up `wt list --format=json` instead of parsing `wt switch`'s undocumented JSON. Pre-check `wt list` before `create` so an existing worktree is reported instead of silently switching. `switch` uses `--no-cd` so the agent never changes directories.
- `remove` maps `force: true` to `wt remove -f` (dirty worktree) and refuses nothing itself - the dirty refusal, `-D` (unmerged branch) and cleanup rules stay in wt. Pass `--no-delete-branch` only when asked to keep the branch, and `--foreground` so the tool result is final.
- `gh pr update` shells out to `gh pr edit` (the `gh pr update` manual page does not exist; update is an alias). Read-only ops parse `--json` output; `pr checks` keys off the `bucket`/`state` fields because exit code 8 means pending, not failure. `auth` runs `gh auth status --json hosts` and, when that is unhelpful, the human form (exit 1 + stderr is the logged-out signal).
- `pr create` and `pr update` are mutating: `execute` builds the request, shows it via `ctx.ui.confirm` (title + body), and only runs `gh` on approval. Declining returns the prepared body as text with a "call again to retry" hint and performs no network write. When `ctx.hasUI` is false, mutating ops return a clear error string instead of writing.
- The PR body is generated from local commits ahead of the base: a summary line per commit subject, with bodies appended when present, and a `Commits` list footer (spec pre-answer 3).
- The `commit` tool has two modes: without `message` it returns the staged diff plus the rules (and a plain report when nothing is staged, instead of diffing an empty index); with `message` it validates, commits, and returns the new commit. It never stages files and takes no paths - the user stages, the tool commits what is staged (spec pre-answer 2).
- Commits run without an approval gate (user decision: commits are non-destructive). The `promptGuidelines` tell the model to present the message in its reply for transparency.
- Message rules are stated in `promptGuidelines`, not hard-enforced: `validateSubject` returns advisory hint strings (out-of-set type, uppercase or past-tense, > 72 chars) that the result text includes; a hint never blocks the commit (spec pre-answer 4, matching `checkAgentRegistry(cwd): string | null`).
- `push: true` commits, then runs `git push` only after `ctx.ui.confirm` shows the branch and remote; declining keeps the commit local and touches nothing remote. No UI: returns guidance text to ask the user, never pushes.
- Errors are text results, never throws: command failures surface the command's stderr verbatim; missing binaries get "wt/gh (not found on PATH): <stderr>"-style messages, mirroring `ask_user`'s `Error: ...` result shape.
- Shared exec helper is `agent/extensions/lib/exec.ts`: `run(cmd, args, { cwd, signal, env })` -> `{ ok, stdout, stderr, code }` over argument arrays only, plus `tryRun` returning `undefined` on failure and ENOENT detection for the "not found" messages. `pi.exec` is not needed by these tools; `node:child_process` keeps them testable with PATH stubs.
- `typebox` is imported the same way `sdd/index.ts` does (transitive resolution, no new dependency; user choice).
- Tests stub `wt` and `gh` with shell scripts on a temp dir prepended to `PATH` (new-but-consistent pattern: `process.env.PATH` mutation per test file with restore), and use `mkdtempSync` git repos per `tests/helpers.ts`.
- README: the layout table stays untouched; add one line noting `/skill:commit-message` was replaced by the `commit` tool so its users learn where the behaviour lives (spec pre-answer 5).

## Changes

- `agent/extensions/lib/exec.ts` (new) - `run`, `tryRun`, ENOENT detection; argument arrays only.
- `agent/extensions/git-worktree/index.ts` (new) - default-export factory registering the `worktree` tool; operation dispatch, `wt` invocation, error text.
- `agent/extensions/git-worktree/worktrees.ts` (new) - pure parsing/formatting of the `wt list` envelope: envelopes -> worktree summaries, current-worktree selection, pre-checks (existing branch/worktree, dirty state summary).
- `agent/extensions/git-gh/index.ts` (new) - `gh` tool: read-only ops, then `pr create`/`pr update` behind `ctx.ui.confirm`.
- `agent/extensions/git-gh/ghops.ts` (new) - pure arg builders and output parsing/formatting for `gh` (JSON parsing for `pr view`/`checks`/`repo view`/`auth`, PR body builder from `git log` commits, checks summariser keyed off bucket/state).
- `agent/extensions/git-commit/index.ts` (new) - `commit` tool: staged-diff readout mode, commit mode with hints, `push: true` confirm path.
- `agent/extensions/git-commit/message.ts` (new) - pure rules: `validateSubject` hints for `feat|fix|chore|refactor`, lowercase, present tense, <= 72 chars; `renderRules` text used in `promptGuidelines` and results.
- `agent/extensions/lib/jinja.ts` - untouched; the new exec module just sits beside it.
- `agent/skills/commit-message/` - deleted (both SKILL.md and the directory); its 4 rules move verbatim in meaning into the `commit` tool's `promptGuidelines`.
- `tests/git-worktree.test.ts` (new) - PATH-stubbed `wt`; list/create/remove/status/switch cases, dirty-create and duplicate-branch failures, stderr surfacing.
- `tests/git-gh.test.ts` (new) - PATH-stubbed `gh`; read-only parsing, body generation, confirm gating for create/update (decline = no network), missing-binary and stderr errors. Real `gh` never runs.
- `tests/git-commit.test.ts` (new) - real temp git repo (helpers style); diff mode, nothing-staged mode, validated commit with hint variants, `push: true` confirm/decline over a PATH-stubbed push target, message-rules unit tests.
- `tests/snapshots/commands.json`, `tests/snapshots/resources.json`, `tests/snapshots/system-prompt.txt` - regenerate with `mise run snapshot` after the skill deletion and tool registration (drop the `skill:commit-message` block; add the `worktree`, `gh`, `commit` snippet lines and commit guidelines).
- `README.md` - one note: the `commit-message` skill became the `commit` tool; `/skill:commit-message` no longer exists. Layout table needs no edit.

## Tasks

- [x] 1. Write `agent/extensions/lib/exec.ts` with `run`/`tryRun` over argument arrays returning `{ ok, stdout, stderr, code }`, ENOENT detection, and strict-flag-safe parsing; no barrel file.
- [x] 2. Build `agent/extensions/git-worktree/` (`index.ts` + `worktrees.ts`): register the `worktree` tool with `promptSnippet`, `promptGuidelines`, TypeBox params (`operation`, `branch?`, `force?`, `keepBranch?`), and execute paths for list/create/remove/status/switch against `wt` with schema-2 parsing, `--no-cd` switching, pre-checks, and stderr-surfacing error text.
- [x] 3. Build `agent/extensions/git-gh/` (`index.ts` + `ghops.ts`): register the `gh` tool with read-only subcommands (`auth`, `pr view`, `pr checks`, `repo view`) parsed from `--json`, and `pr create`/`pr update` (via `gh pr edit`) gated behind `ctx.ui.confirm`; generated PR body from local commits; `hasUI`-false and logged-out error strings.
- [x] 4. Build `agent/extensions/git-commit/` (`index.ts` + `message.ts`): register the `commit` tool; no-message mode returns staged diff + rules (plain report when nothing staged); message mode validates with `validateSubject` hints and runs `git commit`; `push: true` pushes after `ctx.ui.confirm`, declining leaves the commit local; `promptGuidelines` carry the moved skill rules.
- [x] 5. Delete `agent/skills/commit-message/SKILL.md` (and its directory).
- [x] 6. Write `tests/git-worktree.test.ts`, `tests/git-gh.test.ts`, `tests/git-commit.test.ts` following `tests/verification.test.ts` + `tests/helpers.ts`, with a small PATH-stub helper per file and `afterEach` restore; unit-test the pure modules directly and the tools through fake `pi`/`ctx` objects.
- [x] 7. Update `README.md` with the commit-skill-to-tool note and any new-paths wording that keeps the doc truthful.
- [ ] 8. Run `mise run format`, fix lint/type findings, regenerate snapshots with `mise run snapshot`, and run `mise run check` until green.

## Acceptance criteria

- `rg -n "registerTool" agent/extensions/git-worktree agent/extensions/git-gh agent/extensions/git-commit` shows one `registerTool` each with non-empty `promptSnippet` (on the worktree/gh/commit tools), and none of them calls `pi.registerCommand`.
- `agent/extensions/git-commit/message.ts` unit tests pass for all four allowed types, out-of-set types, uppercase and 72-char boundaries.
- `tests/git-worktree.test.ts` passes against the stubbed `wt`: list renders branch/path/dirty/marker from a schema-2 envelope fixture; create pre-checks duplicates and surfaces stderr; remove exercises the dirty/force path; switch maps to `--no-cd`.
- `tests/git-gh.test.ts` passes: read-only ops return parsed output without prompting; a declined `pr create`/`pr update` stub shows the stub script never executed; stderr from a failing stub lands verbatim in the tool result.
- `tests/git-commit.test.ts` passes against a real temp repo: message mode creates a commit visible in `git log`; push: true with a declined confirm leaves `git log` ahead of the remote by exactly one commit and the stubbed push records zero executions; nothing-staged mode reports the empty index plainly.
- `agent/skills/commit-message/` does not exist (`test ! -d agent/skills/commit-message`), and the moved rules appear in the `commit` tool's `promptGuidelines` source.
- `tests/snapshots/commands.json`, `resources.json` and `system-prompt.txt` no longer contain `commit-message` and do contain the three new tool snippets (fixture diff reverified by `rg`).
- `README.md` mentions the `commit` tool replacing `/skill:commit-message`.
- `mise run check` (typecheck, oxlint, oxfmt, vitest, drift) exits 0 with no manual skips.
- Nothing under `agent/` is written at runtime by these tools: no `writeFileSync`/`mkdirSync` in the three new extension dirs (`rg` check).

## Validation pipeline

- `npx vitest run tests/git-worktree.test.ts tests/git-gh.test.ts tests/git-commit.test.ts` - targeted proof for the new extensions and pure modules.
- `mise run snapshot` - regenerates the three snapshot fixtures after the skill deletion; the diff is reviewed by hand.
- `mise run check` - the repo's full gate: typecheck (`npx tsc --noEmit`), lint (oxlint), format (oxfmt --check), tests (vitest), drift (nothing tracked under `agent/` modified).
- `npx oxlint --config .oxlintrc.jsonc agent/extensions/lib agent/extensions/git-worktree agent/extensions/git-gh agent/extensions/git-commit tests/git-*.test.ts` - scoped lint on the new code during development.
- `npx tsc --noEmit` - strict typecheck including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` for all extension and test code.

## Risks

- `wt switch --format=json` output fields are unspecified in wt's help; validated only by stubbing in tests, since the plan re-derives state from `wt list` and never parses switch output.
- `ctx.ui.confirm` is used in-tool by sdd but the headless (no-UI) path in this repo's tests is untested; the plan degrades to refusal-with-errand text when `ctx.hasUI` is false, and tests pin that.
- PATH stubbing across parallel vitest files could bleed; per-file mutation with `beforeEach`/`afterEach` restore plus only ever using the stub for `wt`/`gh`/`git push` keeps the blast radius local.
- `typebox` stays a transitive dependency; if it disappears from `node_modules`, sdd breaks first - the pre-existing failure mode this plan does not fix.
- Deleting the skill changes the system-prompt snapshot; anyone relying on `/skill:commit-message` sees a command disappear, mitigated only by the README note.
- `noUncheckedIndexedAccess` + schema-2 parsing means every `.items[]` and JSON field access needs care; unexpected wt output degrades to an error string, not a crash.

## Out of scope

- No commits, pushes or PRs executed as part of this change; the change ships capability only.
- No issues, releases, tags, reviews, or `gh` auth management.
- No multi-repo, submodule, LFS or hook support; no reimplementation of Worktrunk; no raw `git worktree` calls.
- No slash commands; no cross-extension imports or chaining between the three tools.
- No changes to `agent/settings.json`, the sdd/verification extensions, or `hooks/pre/worktrunk.ts`.
- No runtime state directory: worktrunk keeps its own bookkeeping, and nothing these tools do writes under `agent/`.
