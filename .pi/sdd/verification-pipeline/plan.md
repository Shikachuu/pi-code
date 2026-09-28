# Plan: Verification pipeline

## Summary

Add a `/verify [target]` command that resolves a deterministic git scope in TypeScript, then fans out three read-only agents (code-reviewer, test-engineer, comment-auditor) in one `parallel()` phase via pi-dynamic-workflows. TypeScript then merges their schema-validated reports into the Verification Summary markdown. The three Claude agents are ported as pi-dynamic-workflows agentType definitions in `agent/agents/`. The summary is rendered in the session and injected into LLM context. Report-only. Nothing is persisted and no code is modified.

## Decisions

- Agent definitions: `agent/agents/{code-reviewer,test-engineer,comment-auditor}.md` as agentType defs - pi-dynamic-workflows loads `getAgentDir()/agents` (agent/ via PI_CODING_AGENT_DIR). Frontmatter binds `disallowedTools` and `thinking`. `.pi/prompts/verification/` would be project-only, non-recursive and exposed as slash commands. This deviates from the spec by user choice.
- Synthesis: deterministic TS merge and render, no 4th agent - unit-testable and reproducible. Dedupe is by exact `file:line` only.
- Scope failure: fall back to the uncommitted working tree (`git diff HEAD`) with a visible note in Scope - user choice. A non-git directory is still an error.
- Tiers: all three agents on tier `medium`, thinking from the defs (code-reviewer low, test-engineer low, comment-auditor high) - mirrors the Claude effort levels.
- Smoke tests: test-engineer tries the suite. If setup is missing it reports "blocked" with the missing requirements and never claims a pass.
- Large diffs: no cap. The scope carries the file list, numstat totals and git commands, not the diff body. Over 100 files or 10k changed lines -> UI warning plus a note in Scope, then the run continues.
- Output: `showDocument` doc entry (reuses the ask-user renderer) plus `pi.sendMessage` with `display: false` so the main agent can act on findings.
- Path target: diff of that path vs merge-base with main (committed + uncommitted + untracked). If unchanged, review the file(s) in full.
- Registration: auto-discovery of `agent/extensions/verification/index.ts`. `settings.json` stays unchanged, because adding it to `packages` would load it twice. This deviates from the spec by user choice.
- Git access: `git` CLI via `execFileSync` (no shell, no new dependency).
- Verdict: binary. REQUEST CHANGES if any merged Critical/Important finding exists, any agent returned its own REQUEST CHANGES, or any agent returned no report. Otherwise APPROVE.
- Read-only guard: before running, `/verify` checks that all three agentTypes are registered and deny `edit` and `write`, and fails fast otherwise. An unknown agentType silently falls back to full tools in pi-dynamic-workflows.
- Runner reuse: reuse `runSdd` from `agent/extensions/sdd/runner.ts` for the progress widget, escape-to-stop and model registry wiring. Its API stays unchanged.

## Changes

- `agent/agents/code-reviewer.md`: frontmatter `name`, `description`, `disallowedTools: edit, write`, `thinking: low`. Body ported from Claude `reviewer.md`: five dimensions, severity rules and rules list. The markdown output template is replaced by "return findings in the schema fields". Orchestration/Composition text is dropped.
- `agent/agents/test-engineer.md`: same frontmatter pattern, `thinking: low`. Body ported from Claude `test-engineer.md`: five dimensions, smoke testing, and blocked-setup reporting. Its references to the "run skill" are dropped.
- `agent/agents/comment-auditor.md`: same frontmatter pattern, `thinking: high`. Body ported from Claude `comment-auditor.md`: keep list, suppressions, evidence step, categories, read-only bash rules. The `/no-comments` references are dropped.
- `agent/extensions/verification/scope.ts`: `resolveScope(cwd, arg)` returns a `Scope` with `{ target, kind: "default" | "range" | "ref" | "path" | "fallback", base, mergeBase, files, wholeFiles, commands, stats: { files, insertions, deletions }, notes }`. Base branch is `main`, else `master`. Kinds:
  - Empty arg: `git merge-base <base> HEAD`, then `git diff --name-only <mergeBase>` plus untracked files. Commands `git diff <base>...HEAD`, `git diff HEAD`, `git status --short`.
  - Arg containing `..`: range diff.
  - Arg that resolves as a commit and is not a path: `git diff <base>...<ref>`. When the ref is the base branch itself, it behaves like the empty arg.
  - Arg that is an existing or tracked path: path diff vs merge-base. If empty, `wholeFiles` from `git ls-files -- <path>`.
  - Any git resolution failure: fallback to `git diff HEAD` plus untracked, with a note naming the error.
  - Also exports `isLarge(stats)` (>100 files or >10k lines) and `formatScope(scope)` for prompts and the Scope line.
- `agent/extensions/verification/report.ts`: JSON schemas for the three reports.
  - Common fields: `verdict`, `overview`, `findings[{severity: critical|important|nit, file, line, issue, fix}]`, `doneWell`.
  - code-reviewer adds `verificationStory{testsReviewed, buildVerified, securityChecked}`.
  - test-engineer adds `coverageGaps`, `smokeTest{commands, suite, manual, blocked}`.
  - comment-auditor has `mustKill[]`, `correctness[]`, `nits[]`, `kept[]`, `skipped[]` instead of `findings`.
  - `mergeFindings()` maps auditor Correctness -> Critical, MUST KILL -> Important, Nit -> Nit. It dedupes by `file:line`, keeps the higher severity, joins distinct issue texts, and attributes `[agent, ...]` or `[all]`.
  - `verdict()` and `renderSummary(scope, reports)` produce the spec template in order: Verdict, Scope, Overview, Critical, Important, Nits, Coverage Gaps, Smoke Test Result, Verification Story, Comment Audit (MUST KILL, Correctness, Kept, Skipped), What's Done Well. "none" appears for empty lists. A missing report shows "<agent> did not return a report".
- `agent/extensions/verification/workflow.ts`: `VERIFY_SCRIPT` (meta name `verify`, one phase `Verify`) runs `parallel()` over three `agent()` calls with `agentType`, `tier: 'medium'`, `label` and `schema`, and returns `{ codeReviewer, testEngineer, commentAuditor }`. `verifyArgs(scope)` builds one identical `<scope>` block plus a per-agent task line and schema. `VERIFY_AGENTS` lists the three names.
- `agent/extensions/verification/index.ts`: default export `(pi, options: { run?: WorkflowRunner })` registers `/verify` with description and usage.
  - The handler resolves the scope. An empty scope notifies "Nothing to verify" and stops.
  - A large scope triggers a warning.
  - The handler checks the agent registry guard, then runs `runSdd(ctx, VERIFY_SCRIPT, verifyArgs(scope), { label: "verify", maxAgents: 3, run })`.
  - It renders the summary, calls `showDocument(pi, { title: "Verify: <target>", markdown }, verdict)` and `pi.sendMessage({ customType: "verify-report", content: markdown, display: false })`.
  - Errors are reported via `ctx.ui.notify(..., "error")`.
- `tests/verification.test.ts`: new tests (see Tasks).
- `tests/snapshots/commands.json`, `tests/snapshots/resources.json`: regenerated to include `/verify` and the new extension.

## Tasks

- [x] 1. Create branch `feat/verification-pipeline` (current branch is `feat/sdd`; never commit on main).
- [x] 2. Port the three Claude agents to `agent/agents/*.md` with frontmatter `disallowedTools: edit, write` and thinking low/low/high. Bodies instruct returning schema fields and keep every rule from the originals except orchestration and composition text.
- [x] 3. Implement `scope.ts` (resolveScope for default/range/ref/path/fallback, untracked files, numstat stats, isLarge, formatScope) using `execFileSync("git", ...)`.
- [x] 4. Implement `report.ts` (schemas, mergeFindings, verdict, renderSummary).
- [x] 5. Implement `workflow.ts` (`VERIFY_SCRIPT`, `verifyArgs`, `VERIFY_AGENTS`).
- [x] 6. Implement `index.ts` (`/verify` command, registry guard, runSdd call, showDocument and sendMessage output).
- [x] 7. Write `tests/verification.test.ts` following `tests/sdd.test.ts` style (node:test, assert/strict, temp dirs, runWorkflow stub, fakePi/fakeCtx):
  - Scope tests run against a temp git repo created with `git init -b main` and inline `-c user.*` config. They cover the default branch vs main (committed + uncommitted + untracked), `HEAD~1..HEAD`, a branch ref, a changed path, an unchanged path giving `wholeFiles`, fallback when no main/master exists (note present), an empty scope, a non-git dir error, and the `isLarge` thresholds.
  - Workflow tests check that the script parses and that the stubbed run makes exactly 3 agent calls. Each call must have the right agentType tools policy and tier `medium`, and the same `<scope>` block in every prompt. A null report must still render.
  - Report tests cover dedupe and severity upgrade, `[all]` attribution, auditor category mapping, the verdict rules (nits-only -> APPROVE, important -> REQUEST CHANGES, missing agent -> REQUEST CHANGES, agent REQUEST CHANGES -> REQUEST CHANGES), and template headings in order.
  - Agent def tests parse `agent/agents/*.md` with `parseAgentDefinition` and assert names, `disallowedTools` containing edit and write, and thinking levels.
  - Command tests register `/verify` and run the handler end to end with a stub `run`. They assert the doc entry and sendMessage payload, the "Nothing to verify" path, and fail-fast when an agentType is missing.
- [x] 8. Run `mise run snapshot`, review the diff of `tests/snapshots/commands.json` and `resources.json` (only `/verify` and the verification extension added), then `mise run check`. (typecheck+test pass; drift task fails only on pre-existing unrelated uncommitted changes to agent/extensions/sdd/index.ts and tests/sdd.test.ts from before this branch was created, not from this feature's files.)
- [ ] 9. Manual smoke: in this repo run `pi` and `/verify HEAD~1..HEAD` and confirm the rendered Verification Summary.

## Acceptance criteria

- `/verify` is registered by `agent/extensions/verification/index.ts` and appears in `tests/snapshots/commands.json` and `resources.json` (checked by `mise run test`).
- `agent/settings.json` is unchanged and `tests/packages.test.ts` still passes.
- `resolveScope` returns deterministic file lists and reproduction commands for default, range, ref, path (diff and whole-file) and fallback targets. The fallback carries a note naming the git error. A non-git dir throws (unit tests in `tests/verification.test.ts`).
- Scopes over 100 files or 10k changed lines are flagged by `isLarge` and produce a warning (unit test).
- One `/verify` run makes exactly three agent calls in one parallel phase, with identical scope text, tier `medium`, and read-only agentTypes (stubbed workflow test).
- Merged findings carry `[code-reviewer]`, `[test-engineer]`, `[comment-auditor]`, combined, or `[all]` attributions. Duplicates at the same `file:line` merge at the higher severity. Auditor categories map Correctness -> Critical, MUST KILL -> Important, Nit -> Nit (unit test).
- Verdict is APPROVE only when there are no Critical/Important findings, every agent reported, and none returned REQUEST CHANGES. Otherwise it is REQUEST CHANGES (unit test).
- The rendered summary contains every spec section in order, with specialist sections preserved and "none" for empty lists (unit test).
- Each agent def denies `edit` and `write`, and `/verify` refuses to run if any of the three agentTypes is missing or lacks that denial (unit test).
- The summary is shown as a doc entry and sent to LLM context via `sendMessage` with `display: false`. No files are written by the extension (command test with fake pi).
- `mise run check` passes (typecheck, tests, drift).
- Manual: `/verify HEAD~1..HEAD` in pi on this repo renders a Verification Summary with a verdict and all sections.

## Validation pipeline

- `mise run typecheck` - strict TypeScript over extensions and tests.
- `mise run test` - node:test suite including `tests/verification.test.ts`, snapshot and packages tests.
- `mise run snapshot` - regenerate command and resource snapshots after adding `/verify` (review the diff).
- `mise run check` - typecheck + test + drift. CI runs the same command.
- Manual: `pi` then `/verify HEAD~1..HEAD` in this repo - end-to-end run against real models.

## Risks

- Agent-def `thinking` may not override a thinking suffix baked into the tier spec (`medium` = `opus:minimal`). The tests only assert the option is passed, so confirm the effective level in the manual run.
- `disallowedTools` blocks edit and write but not bash. test-engineer must run tests, so read-only rests on the prompt plus the existing protected-paths guard. Test runs can still create artifacts.
- Exact `file:line` dedupe misses semantically identical findings on different lines. The summary can show near-duplicates.
- Schema validation failure throws in pi-dynamic-workflows and bypasses retries. One malformed agent reply becomes a missing report and forces REQUEST CHANGES.
- Base branch detection assumes `main` or `master`. Other default branches hit the working-tree fallback unless passed explicitly as a ref.
- The working-tree fallback on a typo'd range can hide user error. It stays visible only via the Scope note.

## Out of scope

- Blocking gates: commit hooks, CI integration, auto-fix, and a `/no-comments` port.
- Persisting findings, creating issues, or writing reports to disk.
- PR refs as targets.
- Per-project tier configuration and a third verdict.
- Semantic (LLM) dedupe of findings.

## Results

- [x] /verify is registered by agent/extensions/verification/index.ts and appears in tests/snapshots/commands.json and resources.json: pass - mise run snapshot regenerated both files; diff limited to the verify command and verification extension. 92/92 tests pass.
- [x] agent/settings.json is unchanged and tests/packages.test.ts still passes: pass - agent/settings.json untouched; packages.test.ts passes as part of the 92-test run.
- [x] resolveScope returns deterministic file lists and reproduction commands for default, range, ref, path (diff and whole-file) and fallback targets; fallback carries a note; non-git dir throws: pass - 9 scope tests pass, including the new dash-injection guard and unknown-ref-throws behavior added after code review.
- [x] Scopes over 100 files or 10k changed lines are flagged by isLarge and produce a warning: pass - unit test plus new handler-level test '/verify warns on a large scope but still runs' (fires warning, run still invoked).
- [x] One /verify run makes exactly three agent calls in one parallel phase, with identical scope text, tier medium, and read-only agentTypes: pass - workflow test using the real agent/agents/*.md registry passes.
- [x] Merged findings carry attributions and dedupe with severity escalation; auditor categories map Correctness->Critical, MUST KILL->Important, Nit->Nit: pass - report.ts unit tests pass unchanged.
- [x] Verdict is APPROVE only when no critical/important findings, every agent reported, and none returned REQUEST CHANGES; otherwise REQUEST CHANGES: pass - verdict unit tests pass; new handler test asserts the exact doc status string for both APPROVE and REQUEST CHANGES cases.
- [x] Rendered summary contains every spec section in order, specialist sections preserved, 'none' for empty lists: pass - renderSummary tests unchanged and passing.
- [x] Each agent def denies edit and write, and /verify refuses to run if any of the three agentTypes is missing or lacks that denial: pass - new test '/verify refuses to run when an agentType denies edit but not write' added and passes, closing the gap the code-reviewer flagged; missing-agent case also covered.
- [x] Summary is shown as a doc entry and sent to LLM context via sendMessage with display:false; no files written by the extension: pass - handler test asserts one appendEntry and one sendMessage(display:false) call; no fs writes in extension code.
- [x] mise run check passes (typecheck, test, drift): pass - npx tsc --noEmit clean; node --test tests/*.test.ts 92/92 pass; drift clean after reverting the unrelated agent/extensions/sdd/index.ts reformat, allowlisting agent/agents/** in agent/.gitignore, and committing this feature's files (commit 0d7dd8b).
- [x] Manual: /verify HEAD~1..HEAD in pi on this repo renders a Verification Summary with a verdict and all sections: pass - User ran /verify manually and received a full Verification Summary with verdict, scope, overview, all findings sections, specialist sections and comment audit -- confirming end-to-end behavior. Its Important-severity findings (unrelated sdd/index.ts reformat, git-option-injection risk in rangeScope, silent phantom-path fallback for mistyped refs, untested partial-deny guard, stale test comment/dead var) have all been fixed and are now covered by new tests.
