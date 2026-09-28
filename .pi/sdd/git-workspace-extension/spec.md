# Agentic git tools: Worktrunk workspaces, gh PRs, and commits

## Goal

Give the agent native tools (not slash commands) for three git concerns, each owned by its own auto-discovered pi extension:

1. `agent/extensions/git-worktree/` - workspace management through Worktrunk (`wt`), the tool the machine already uses.
2. `agent/extensions/git-gh/` - GitHub CLI: read-only inspection plus the PR lifecycle.
3. `agent/extensions/git-commit/` - the commit flow, which absorbs the rules currently in `agent/skills/commit-message/SKILL.md`, so `/skill:commit-message` becomes the `commit` tool.

Everything is exposed through `pi.registerTool` with `promptSnippet` and `promptGuidelines`, following `agent/extensions/ask-user/index.ts:50` and `agent/extensions/sdd/index.ts:353`. The model decides when to call them; there are no `/worktree`, `/pr` or `/commit` commands. The three extensions do not call each other. Each tool operates on the current working directory unless it is handed a path.

## Background

- The repo already has a proven extension precedent: `agent/extensions/verification/index.ts:49` uses `export default function (pi, options)`, a prerequisite check returning a clear error string (`agent/extensions/verification/index.ts:44`), and a `registerEntryRenderer` with `getMarkdownTheme`.
- Tool registration precedent: `pi.registerTool({ name, label, description, promptSnippet, parameters, execute })` with `ctx.ui.notify` and `ctx.hasUI` checks, as in `agent/extensions/ask-user/index.ts:50-100` and `agent/extensions/sdd/index.ts:353-395`.
- Worktrunk is already installed and integrated. `hooks/pre/worktrunk.ts:14-21` shells out to `wt config state marker` via `pi.exec("wt", [...], { cwd })` to set the agent activity markers that `wt list` shows. The plugin is registered globally with `wt config plugins pi install`.
- Git CLI access already exists in TypeScript and is resolved through `execFileSync` with an argument array, never a shell string (`agent/extensions/verification/scope.ts:25-28`, with `tryGit` fallbacks at :31).
- The current `commit-message` skill (`agent/skills/commit-message/SKILL.md`) is a 4-step prose procedure: read `git diff --cached`, write `<type>: <summary>` from `feat|fix|chore|refactor` with a lowercase present-tense summary <= 72 chars, add a body only when the reason is not obvious, then show the message and wait for approval before `git commit`.
- Skills are auto-discovered from `agent/skills/*/SKILL.md` and surface as `/skill:<name>` (`README.md:26`). Their presence is baked into test fixtures: `tests/snapshots/commands.json:171`, `tests/snapshots/resources.json:9`, `tests/snapshots/system-prompt.txt:144`. Deleting the skill changes all three.
- `agent/` is tracked config; `mise run drift` fails if pi mutates it at runtime, so runtime state such as worktree bookkeeping cannot be written there.

## Scope

Three new auto-discovered extensions, each with `index.ts` plus small pure modules, plus one test file each. `agent/settings.json` is untouched.

**`agent/extensions/git-worktree/`** - one `worktree` tool, no commands.

- `worktree` operations: `list`, `create <branch>`, `remove <branch>`, `status`, `switch <branch>`, all delegated to `wt` (Worktrunk), not to raw `git worktree`. Worktrunk owns worktree layout, hooks, config and the activity markers that `hooks/pre/worktrunk.ts` already sets.
- Outputs go to the model's context as tool results (branch, path, dirty state, marker) so the agent can reason about them and tell the user; the user runs `wt list` when they want the rendered view.
- Fails with a clear message when `wt` is missing or the branch already has a worktree.

**`agent/extensions/git-gh/`** - one `gh` tool, no commands.

- Read-only inspection: `auth status`, `pr view`, `pr checks`, `repo view`. No prompt, no network mutation.
- PR lifecycle: `pr create`, `pr update`, using local commits as the PR body source.
- `gh` failures surface stderr; a missing `gh` or missing login is reported as a clear error string.

**`agent/extensions/git-commit/`** - one `commit` tool, no commands.

- Reads the staged diff, returns guidance derived from the rules the skill documents so the model writes `<type>: <summary>`, shows it, and only then asks for approval before `git commit` runs locally.
- `push: true` commits locally and then stops: the tool tells the model to ask the user explicitly before any network write. Declining leaves the commit local and touches nothing remote.
- Delete `agent/skills/commit-message/` so the rules have a single owner. The rules become `promptGuidelines` on the tool, which is where a model actually reads them.

**Shared and repo-level**

- A shared module under `agent/extensions/lib/` that wraps `execFile`/`execFileSync` with argument arrays and returns `{ ok, stdout, stderr }`, used by all three extensions for `git`, `gh` and `wt`.
- Tests `tests/git-worktree.test.ts`, `tests/git-gh.test.ts`, `tests/git-commit.test.ts` following `tests/verification.test.ts`, using the `mkdtempSync` plus `git()` helper style from `tests/helpers.ts`. `wt` is stubbed on `PATH` so tests never touch a real Worktrunk install.
- Regenerate `tests/snapshots/{commands,resources}.json` and `tests/snapshots/system-prompt.txt` after the skill moves, and update `README.md` so the layout table stays truthful.

## Non-goals

- No commits, pushes or PRs are executed as part of this change. The change ships capability only.
- The three extensions do not import each other or chain state. Coordination is the agent's job at runtime.
- No reimplementing Worktrunk. No raw `git worktree` calls that would bypass `wt` bookkeeping.
- No issues, releases or tag handling.
- No multi-repo, submodule, LFS or hooks support.
- No token or auth management. `gh` is assumed already authenticated.
- No rewriting of the sdd or verification extensions.
- No re-authoring of the commit-message guidance. Its content moves in meaning; only its home changes.

## Expected behaviour

- Calling the `worktree` tool with `list` returns every worktree with branch, path, dirty state and agent marker, sourced from `wt list`.
- `create` goes through `wt switch -c`/its create path and fails with a readable message if the branch or worktree already exists.
- `remove` refuses when the worktree is dirty unless forced, and goes through `wt remove` so Worktrunk's cleanup rules apply.
- `status` reports branch, path and dirty state for the repo it is invoked in.
- The `commit` tool returns the staged diff plus the message rules; a message with staged changes matches `<type>: <summary>` from the allowed type set, summary lowercase, present tense, <= 72 chars, with a body only when the diff does not explain the reason. The tool does not run `git commit` until the model has shown the message and the user approved.
- The `commit` tool with nothing staged reports that plainly instead of diffing an empty index.
- With `push: true` the commit is local and the tool's result instructs the model to ask before pushing. Declining leaves the commit in place.
- `pr create` builds a body from the local commits and asks before sending it to GitHub.
- Read-only `gh` operations return parsed output with no prompt.
- Any `git`, `wt` or `gh` failure surfaces the command's stderr in the tool result instead of a generic error, mirroring the error handling in `agent/extensions/ask-user/index.ts:88-95`.

## Constraints

- TypeScript ESM on Node >= 22.19. Imports of node builtins and pi packages use explicit `.ts`/package extensions. No barrel files.
- Capabilities are `pi.registerTool` entries with `promptSnippet` and `promptGuidelines`. No `pi.registerCommand` for this feature.
- Shell out with argument arrays for `git`, `wt` and `gh` (`execFile`, or `pi.exec` where the host provides it, as in `hooks/pre/worktrunk.ts:17`). No interpolated shell strings.
- Each extension follows the `verification` shape: `index.ts` for registration and orchestration, small exported pure modules beside it for logic that gets unit-tested directly.
- Extensions are discovered from their directories. `agent/settings.json` is untouched.
- Must pass `mise run check`: typecheck, oxlint, oxfmt, vitest, and the snapshot/drift gates.
- Nothing under `agent/` may be written at runtime.

## Assumptions

- `wt` is on `PATH`; the Worktrunk pi plugin is already installed (`wt config plugins pi install`), and `hooks/pre/worktrunk.ts` keeps working unchanged.
- `agent/skills/commit-message/SKILL.md` is deleted, not copied, and its rules live in the `commit` tool's `promptGuidelines`.
- The skill's `/skill:commit-message` entry point disappears with the file; the model reaches the same behaviour through the `commit` tool.
- Tool names `worktree`, `gh` and `commit` do not collide with existing tool names (`ask_user`, the sdd `*` tools, verification's).
- `gh` is installed and logged in on the machine; no auth flow is built.
- "Workspace" in the request means git worktrees, managed by Worktrunk; the multi-repo reading was rejected.

## Open questions

- Should the `worktree` tool take a `wt` subcommand passthrough parameter, or a closed set of operations validated by the extension?
- Should `commit` stage files itself, or stay strictly scoped to what the user already staged?
- For PR creation, should the body be the commit body verbatim or a generated summary with the commit list appended?
- Should the message rules (`feat|fix|chore|refactor`, 72 chars) be hard-enforced by the extension or only stated in `promptGuidelines`? What happens on a type outside the set?
- Does deleting the skill need a note in `README.md` so anyone using `/skill:commit-message` learns the behaviour now lives in a tool?
