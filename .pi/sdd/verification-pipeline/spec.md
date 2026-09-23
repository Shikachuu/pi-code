# Verification Pipeline

## Goal

Enable on-demand parallel verification of code changes across multiple dimensions (code quality, test coverage, builds, comments) with detailed, categorized findings. Port the Claude `/verify` workflow and its three agents (code-reviewer, test-engineer, comment-auditor) to pi-dynamic-workflows.

## Background

The user's Claude configuration includes a sophisticated verification command that:
- Orchestrates three independent agents in parallel: code-reviewer, test-engineer, comment-auditor
- Each agent evaluates changes across specific dimensions and outputs categorized findings (Critical / Important / Nit)
- A coordinator agent synthesizes all three reports into a unified verdict and merged findings
- The output is detailed, actionable, and never blocks work (report-only mode)

This workflow provides pre-merge verification without CI/CD overhead, fitting developers' local workflows. Porting it to pi-dynamic-workflows makes it available in the pi harness alongside other project workflows.

## Scope

### In scope

- Create `/agent/extensions/verification/` extension with pi-dynamic-workflows equivalents
- Define workflow scripts (as template strings) that orchestrate parallel verification agents:
  - Code review agent: evaluates correctness, readability, architecture, security, performance
  - Test assessment agent: judges test coverage, correctness, design, reliability, maintainability; runs suite and smoke tests
  - Comment audit agent: hunts narration, commented-out code, and lint suppressions against a keep list
- Define agent prompts as markdown files in `.pi/prompts/verification/` following pi's template format:
  - `code-reviewer.md`: instructions for code review across five dimensions
  - `test-engineer.md`: instructions for test assessment and smoke testing
  - `comment-auditor.md`: instructions for comment audit with keep-list rules
- Provide a coordinator workflow that:
  - Establishes scope (path, commit range, or branch vs main)
  - Fans out all three agents with identical scope
  - Synthesizes reports into unified verdict: APPROVE or REQUEST CHANGES
  - Merges findings by severity, attributes findings to source agents
  - Preserves specialist sections (smoke test result, coverage gaps, comment audit decisions)
- Register extension in `agent/settings.json` packages array
- Add tests following existing test patterns in the project

### Non-goals

- Implement as blocking gate (commit hooks, CI/CD integration, auto-fix)
- Persist findings or create issues
- Modify or execute code based on verification results
- Replace local linting or testing workflows
- Support real-time verification during development

## Expected behaviour

### Command invocation

User runs `/verify` with optional target:

```
/verify                    # Current branch vs main (committed + uncommitted changes)
/verify HEAD~3..HEAD       # Specific commit range
/verify path/to/file.ts    # Single file
/verify main              # Branch against main
```

### Execution

1. **Scope establishment:** Resolve the target to a diff; build a scope descriptor listing changed files and commands to reproduce the diff
2. **Parallel execution:** Launch all three agents concurrently with the identical scope descriptor
3. **Report collection:** Each agent returns a report with findings in Critical / Important / Nit categories plus agent-specific sections
4. **Synthesis:** Coordinator merges reports:
   - Verdict: APPROVE (if all pass and only nits), REQUEST CHANGES (if any agent flags Critical or Important)
   - Critical / Important / Nits: combined list with attributions (`[code-reviewer]`, `[test-engineer]`, `[comment-auditor]`, or `[all]`)
   - Specialist sections: test-engineer's Smoke Test Result and Coverage Gaps; code-reviewer's Verification Story; comment-auditor's MUST KILL, Correctness, Kept, Skipped

### Output format

```markdown
## Verification Summary

**Verdict:** APPROVE | REQUEST CHANGES
**Scope:** [files reviewed, commands to reproduce diff]
**Overview:** [2-3 sentences combining all three perspectives]

### Critical
- [code-reviewer|test-engineer|comment-auditor|all] file:line issue

### Important
- [all] file:line issue

### Nits
- [code-reviewer] file:line description

### Coverage Gaps (from test-engineer)
- Concrete untested behavior and recommended test case

### Smoke Test Result (from test-engineer)
- Commands run / suite pass-fail / manual smoke observations

### Verification Story (from code-reviewer)
- Tests reviewed / build verified / security checked

### Comment Audit (from comment-auditor)
- MUST KILL: file:line comment -> delete/refactor target
- Correctness: file:line suppression -> rule name and guilty symbol
- Kept: file:line keep-list item and proof
- Skipped: files that could not be read

### What's Done Well
- Positive observations from any agent
```

## Constraints

- On-demand only; no automatic triggers (hooks, CI, scheduled runs)
- Report-only; findings never block code, commits, or PRs
- Must run in isolation per invocation; no shared state across runs
- Agents work read-only (no code edits, test writes, or comment modifications)
- Parallel execution of three agents in one orchestration phase
- Scope must be deterministic and reproducible (exact commit range or file list)

## Assumptions

- The three agent types (code-reviewer, test-engineer, comment-auditor) map cleanly to pi agent tiers
- Test suite can be auto-detected (package.json scripts, Makefile, etc.) and run without setup
- Diff can be computed reliably for branch, path, and commit-range targets
- Users have access to all changed files and git history needed for scope analysis
- Findings are actionable without a linked issue or broader context
- Project has pi-dynamic-workflows available with `agent()` and `parallel()` orchestration primitives

## Open questions

1. **Scope detection fallback:** If git merge-base or diff fails, should `/verify` default to whole repo diff, or fail with an error?
2. **Smoke test environment:** When test suite requires setup (db init, env vars, docker), should the pipeline skip smoke tests, or document setup requirements in output?
3. **Large diffs:** Should scope limit diff size (e.g., >100 files or 10k LOC) to avoid overwhelming agents? If so, fail or sample?
4. **Verdict granularity:** Should coordinator offer a middle verdict like "REVIEW REQUIRED" (findings exist but no Critical/Important), or stick to binary APPROVE/REQUEST CHANGES?
5. **Agent tier selection:** Should code-reviewer and test-engineer run at "medium" tier (e.g., opus) for thoroughness, or configurable by project?
