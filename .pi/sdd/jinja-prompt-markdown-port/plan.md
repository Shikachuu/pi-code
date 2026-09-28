# Plan: Port hand-rolled prompt and markdown templates to @huggingface/jinja

## Summary

Replace the hand-written string, split and regex handling of prompt and markdown rendering in `agent/extensions/` with the official `@huggingface/jinja` package. Prompts and markdown documents render from tracked `.jinja` template files; the section-parsing API (`headingLines`, `sectionBounds`, `readSection`, `replaceSection`, `validatePlan`) stays imperative TypeScript because the library cannot express it (no custom filters, no split or regex filters, only basic builtins). All `prompts.ts` exports keep their names, signatures and types, so `sdd/index.ts` and tests need no import changes. Workflow prompt texts in `workflows.ts` and the verification summary in `verification/report.ts` move to templates too. Rendering is verified against goldens captured from the pre-port code, so any prompt-text deviation is deliberate and documented, never silent.

## Decisions

- Parsing stays TypeScript: only rendering moves to Jinja - the library has no custom filters or tests, no split filter, and a fence scanner cannot be written with builtins; forcing it through a template would be strictly worse than the current code.
- Heading rules stay lenient and unchanged: case-insensitive `##` match and fence-aware termination stay as today, so `tests/sdd.test.ts:1164-1173` passes untouched.
- `demoteHeadings` gains fence awareness: fenced lines are skipped exactly like the section scanner does. This is a documented behaviour change (spec requires it, code did not do it, no test pinned it).
- One `.jinja` file per prompt or rendered doc. Loaders resolve relative to `import.meta.dirname` and cache `Template` instances; no includes exist in the library so composition stays manual.
- `renderResearch`, `planPrompt`, `implementPrompt`, `renderSummary` and all `workflows.ts` prompt builders become template renderers with identical parameter shapes.
- `SPEC_TEMPLATE` and `PLAN_TEMPLATE` render once at first use from their `.jinja` sources and are still exported as plain strings interpolated by `workflows.ts`.
- `validatePlan` keeps its regex checks in TypeScript and consumes sections as today; its error strings stay identical.
- Prompt fidelity is pinned by goldens captured from current code before the port, stored in `tests/fixtures/sdd-golden/`, compared byte for byte; every remaining difference is listed in `.pi/sdd/jinja-prompt-markdown-port/deviations.md`.
- Workflow scripts `DISCOVERY_SCRIPT` and `RESEARCH_SCRIPT` keep their runtime JS concatenations for JSON payloads (`<probe>`, `<probe-results>`, `SOURCES JSON`, `SUPPORTED CLAIMS JSON`) because workflow scripts cannot read files; only the static prompt texts move.
- `@huggingface/jinja` is pinned exact `0.5.10` in `package.json` and `package-lock.json`; `mise.lock` is unchanged (the postinstall hook runs `npm ci`, so both files change in the same commit).

## Changes

- `package.json` / `package-lock.json`: add `@huggingface/jinja` `0.5.10` as an exact dependency; regenerate the lock so `npm ci` in the mise postinstall hook stays in sync.
- New `agent/extensions/jinja.ts`: cached template loader (`readFileSync` + `new Template(source)` per file keyed by absolute path) reading templates via `import.meta.dirname`; `maxRetries`-free, no environment options.
- New `agent/extensions/sdd/templates/*.jinja` (tracked, hand-kept style, ~15 files): `spec-template`, `plan-template`, `research-report`, `plan-prompt`, `implement-prompt`, `enrich-scope`, `enrich-repo`, `enrich-questions`, `draft-prompt`, `discovery-plan`, `discovery-probe`, `discovery-synth`, `research-queries`, `research-gather`, `research-verify`, `research-report-prompt`.
- New `agent/extensions/verification/templates/verification-summary.jinja`.
- `agent/extensions/sdd/prompts.ts`: templates and docs render via the loader; parser code (headingLines, sectionBounds, readSection, replaceSection) unchanged in logic; demoteHeadings becomes fence-aware; section handling keeps lenient case-insensitive match.
- `agent/extensions/sdd/workflows.ts`: rich context objects passed to templates; scripts `SINGLE_SCRIPT`, `ENRICH_SCRIPT`, `DISCOVERY_SCRIPT`, `RESEARCH_SCRIPT` and their runtime JS concat logic unchanged.
- `agent/extensions/verification/report.ts`: renderSummary rewritten to render the template from pre-computed merged findings, verdict text and per-agent sections; mergeFindings, verdict, auditToFindings and attribution stay TypeScript.
- New tests `tests/jinja-golden.test.ts` (byte-for-byte golden comparisons for every migrated prompt and rendered markdown doc) and new cases in `tests/sdd.test.ts` and `tests/verification.test.ts` for whitespace-sensitive output, missing headings, fenced code blocks containing `##` lines, heading demotion with fences, and replaceSection append vs replace.
- `.pi/sdd/jinja-prompt-markdown-port/deviations.md`: every intentional prompt-text deviation from the golden output, listed with its reason.

## Tasks

- [x] 1. Pin the dependency: `npm install --save-exact @huggingface/jinja` (0.5.10) and verify `package-lock.json` is in sync so `npm ci` still succeeds.
- [x] 2. Capture goldens from pre-port code: one-off script writes today's output of `planPrompt` (each branch: with/without discovery, research, memory), `implementPrompt`, `renderResearch`, `enrich/draft/discovery/research` prompts and `renderSummary` into `tests/fixtures/sdd-golden/*.txt`, plus a helper `tests/golden.ts` that reads them.
- [x] 3. Build `agent/extensions/jinja.ts` loader with typecheck-clean signatures, a `Template` cache, and clear failure if a template file is missing.
- [x] 4. Create the `sdd/templates/*.jinja` files and port `prompts.ts`: templates, renderResearch, planPrompt, implementPrompt, fence-aware demoteHeadings; keep every export name, signature and type identical.
- [x] 5. Port `workflows.ts` prompt builders to templates; keep the script strings and concat JS untouched.
- [x] 6. Port `verification/report.ts` renderSummary to `verification-summary.jinja`; keep mergeFindings, verdict, auditToFindings attribution in TypeScript.
- [x] 7. Write `deviations.md` from a diff of golden output against migrated output; every difference is either fixed (indentation, trailing newline, blank-line collapse) or listed and justified.
- [x] 8. Extend tests: whitespace-sensitive renders (`## Open questions\n\n- None`, `- `[cmd]` - <what>` lines), missing headings, `##` inside code fences for both the section scanner and demoteHeadings, replaceSection replace-in-place plus append plus single trailing newline, and golden comparisons.
- [x] 9. Run the full validation pipeline until green; confirm `mise drift` still passes (no runtime writes under `agent/`).

## Acceptance criteria

- `mise run check` passes end to end: typecheck, lint, format:check, test (all existing tests untouched still green), drift.
- Golden tests in `tests/jinja-golden.test.ts` assert byte-for-byte equality between migrated renderers and the captured goldens for every migrated prompt and markdown body, except differences listed in `deviations.md`.
- `grep`ing `agent/extensions/sdd/prompts.ts` finds no remaining multi-line template literal prompt bodies, only loader calls and rendering; the section parsing API (`readSection`, `replaceSection`, `demoteHeadings`, `validatePlan`, `renderResearch`, `planPrompt`, `implementPrompt`, `SPEC_TEMPLATE`, `PLAN_TEMPLATE`) keeps its names, params and return types (typecheck passes).
- `demoteHeadings` leaves fenced code blocks unchanged: a new test asserts headings inside fences stay at their original level while headings outside are demoted.
- Existing prompt-adjacent tests still pass unchanged: `tests/sdd.test.ts:184-210` renderResearch shape, `:274` `<existing-discovery>\nOLD`, `:283` `<memory>m</memory>`, `:519` `<feedback>\nmention limits`, `:1164-1173` fence and case-insensitive leniency, and `tests/verification.test.ts:324-353` renderSummary ordering and missing-agent text.
- `mise run drift` stays clean after running the test suite, proving no runtime writes under `agent/`.
- `@huggingface/jinja` appears in both `package.json` and `package-lock.json` pinned at `0.5.10`; `mise.lock` is unchanged.

## Validation pipeline

- `mise run check` - full gate: typecheck, oxlint, oxfmt check, vitest, drift.
- `npx vitest run tests/jinja-golden.test.ts` - byte-level prompt fidelity against pre-port goldens.
- `npx vitest run tests/sdd.test.ts` - section/marker rules and plan validation still behave identically.
- `npx vitest run tests/verification.test.ts` - renderSummary shape, ordering and verdict still intact.
- `mise run drift` - no runtime writes under `agent/`.
- Manual: `/spec` end to end on scratch input inspecting the draft prompt visually before accepting (only if goldens were captured with real inputs, which they are).

## Risks

- Jinja differences in whitespace collapse (multi-line template indentation, trim_blocks vs lstrip_blocks, `keep_trailing_newline`) could subtly change prompt text; mitigation: goldens force anything that differs to be fixed or explicitly documented.
- `{{` or `{%` sequences in prompt text would break rendering; audited: migrated texts contain none, and runtime JSON is passed as template variables, not interpolated into the source; a regression test asserts no curly-brace syntax appears outside intentional template expressions at run time.
- `import.meta.dirname` fails if extension code is ever bundled; acceptable today, since no bundling exists in this repo, but it narrows future refactoring.
- `npx tsc` may need to see `.jinja` files only via the loader, not imports; the tsconfig include stays `.ts` only, so no config change is needed; bundler or pack tool changes are out of scope.
- oxlint may flag the new loader's dynamic access; will adjust loader style if lint complains rather than weakening rules.

## Out of scope

- Prompt wording, prompt content, or system prompt text; only the rendering mechanism changes.
- Model-reply JSON parsing, git output parsing in `verification/scope.ts`, slugify in `sdd/store.ts`.
- `agent/agents/*.md`, `agent/APPEND_SYSTEM.md`, `agent/prompts/*.md`, `agent/skills/*/SKILL.md` (static, no template syntax).
- ask-user/review.ts TUI rendering beyond what a changed markdown shape forces.
- Changing prompt caching, ordering, agent routing, agentTypes, tiers, or verification verdict logic.
- Upgrading unrelated dependencies, refactoring unrelated code, reformatting untouched files.
- Committing, pushing, or opening a PR.

## Verification

- verdict: REQUEST CHANGES

### Verification Summary

**Verdict:** REQUEST CHANGES

**Scope:**
(default) (default) - 56 file(s). Commands: git diff main...HEAD; git diff HEAD; git status --short

**Overview:** Prompt and markdown rendering moved from TypeScript template literals and string surgery to 18 tracked `.jinja` files rendered through a cached `@huggingface/jinja` loader (`agent/extensions/lib/jinja.ts`), with 23 byte-exact goldens captured from the pre-port code. The port is faithful (I re-derived three goldens from `main`'s code by hand and they match), the parsing API kept its names, types and behaviour, the one documented behaviour change (`demoteHeadings` is now fence-aware) is consistent with the existing fence rule in `headingLines`, and `mise run check` is green. Remaining issues are nits: the golden harness has no regeneration path and diverges from the repo's existing `matchSnapshot`/`mise run snapshot` convention, template context keys are no longer type-checked, the loader's unconditional trailing-newline strip has an untested invariant, and the demote-before-replace ordering obligation is now both unenforced and undocumented. This branch ports every SDD prompt and the verification summary from hand-built strings to Jinja templates, and adds a golden-fixture test suite plus targeted unit tests. Test health is good: the goldens are genuine pre-port captures (I rendered main's old string-building code and all 23 outputs match the fixtures byte for byte), the suite is deterministic across 3 repeat runs and a shuffled order, and the whole `mise check` gate (typecheck, lint, format:check, test, drift) is green. Two issues block merge: one test in `tests/jinja.test.ts` is tautological and names a caching contract nothing enforces, and the new loader's only error branch is uncovered. Scanned all 56 in-scope files (committed diff main...HEAD plus clean working tree). The change contains exactly one source-level comment, at agent/extensions/lib/jinja.ts:24-25, and it clears keep-list item 2 against the vendored library source; zero comments to delete, zero suppressions of any kind present.

#### Critical
- none

#### Important
- [test-engineer] tests/jinja.test.ts:18 The test 'renderTemplate parses a template once and reuses it for later renders' cannot fail. It writes `v={{ v }}`, renders with v=1, then overwrites the same path with `changed={{ v }}` and asserts the result is `v=2`. Both the cached and the uncached implementation render `v=2` because the variable name is unchanged, so the assertion proves nothing about caching. I confirmed this by driving the real loader: a cached second render yields `v=2`, and a cache-free re-parse would yield the same string. Deleting the `cache` Map from `agent/extensions/lib/jinja.ts` would not fail this test or any other. The real contract (a template edited on disk mid-process is silently ignored) is therefore unpinned. -> Either make the second render observably different - keep the same variable name and assert the result is still `v=2` (a cache hit proves it, a re-parse would return `CHANGED:2`) - or, if re-parsing is acceptable, delete the `cache` Map and drop the misleading name. Pick one and assert it.
- [test-engineer] agent/extensions/lib/jinja.ts:19 The `cannot parse template <path>: <reason>` catch branch has no test. `rg 'cannot parse'` matches only the source, and the three tests in `tests/jinja.test.ts` cover only the missing-file, verbatim-substitution and (ineffectively) cache paths. This branch is the one that matters: `SPEC_TEMPLATE` and `PLAN_TEMPLATE` render at module-import time, so a syntax error in a shipped `.jinja` file surfaces as a raw `@huggingface/jinja` parse error while the extension loads, with no path in the message. I hit this path manually with `{% if %}` and the wrapper message did appear, so the code works - it is simply unverified by the suite. -> Add a test that writes a syntactically invalid template to a fresh temp path and asserts `renderTemplate(path)` throws a message matching both the template path and the underlying parse reason, so a future refactor that drops the wrapper fails the test.

#### Nits
- [code-reviewer] tests/golden.ts:6 `golden()` introduces a second fixture convention alongside the repo's existing `matchSnapshot` helper (`tests/helpers.ts:51`) and `mise run snapshot`, but with a weaker contract: no `UPDATE_GOLDENS` path, no helpful error when a fixture is missing (raw ENOENT instead of "run `mise run snapshot`"), and all 23 fixtures deliberately lack a trailing newline. The first intentional prompt-wording change will require hand-editing up to 23 files, which is how byte-exact goldens get silently rubber-stamped, and an editor that adds a trailing newline to one fixture produces a confusing failure. README documents the regeneration workflow for `tests/snapshots/` but says nothing about `tests/fixtures/sdd-golden/`. -> Route the goldens through the existing convention: add `UPDATE_GOLDENS` handling in `tests/golden.ts` that writes the actual render (matching `matchSnapshot`'s behaviour, including the error message pointing at the update command), add a `mise run golden` task next to `mise run snapshot`, and regenerate the 23 fixtures with a final newline so hand-edits are diff-clean.
- [code-reviewer] agent/extensions/lib/jinja.ts:12 The context is `Record<string, unknown>`, so template variable names are no longer checked by tsc. I verified the failure mode: `renderTemplate(research-gather.jinja, {})` renders an empty first line instead of failing, so a typo such as `{{ specc }}` in `plan-prompt.jinja` ships a prompt with a silently empty `<spec>` block. Impact is low only because every one of the 18 templates is pinned by a golden, but this is a real loss of the compile-time safety the template literals had. -> Add a generic overload `export function renderTemplate<T extends object>(path: string, context: T): string` plus an exported context interface per template, or have each caller pass a typed constant, so a renamed context key becomes a type error rather than an empty prompt.
- [code-reviewer] agent/extensions/lib/jinja.ts:26 The trailing-newline strip is applied to the rendered output, so it also eats a newline that belongs to the data: a template ending in a bare `{{ value }}` whose value ends with `'\n'` loses it. No shipped template ends in a value today (all end in literal text or `{% endif %}`), so this is latent, but the invariant is neither stated nor pinned by a test - `tests/jinja.test.ts` covers the missing-file, cache and verbatim-substitution paths only. -> State the invariant in the comment ("a rendered value must not end in a newline") and add a case to `tests/jinja.test.ts` that renders a template whose only content is `{{ value }}` with `value = 'x\n'` and asserts the documented result, or scope the strip to the case it was written for by comparing against the source's own trailing newline.
- [code-reviewer] agent/extensions/sdd/prompts.ts:49 `demoteHeadings` must be called before `replaceSection`, otherwise the un-demoted `## Verification Summary` heading in the verification report terminates the `## Verification` section it is being written into. The only caller (`agent/extensions/sdd/index.ts:456`) gets it right, and this diff deleted the comment that documented the obligation, so a future caller can now get the order wrong with no signal. The fence rule itself is correct: it matches `headingLines` exactly (`/^\s*```/`), so an unbalanced fence affects demotion and section scanning consistently and cannot desynchronize them. -> Move the demotion inside `replaceSection` (which already owns section scanning) and drop the exported `demoteHeadings` helper, so the ordering cannot be violated; or keep the export and restore a one-line warning at the call site in `index.ts:456`.
- [test-engineer] tests/jinja-golden.test.ts:211 The 'rendered prompts contain no unrendered template syntax' sweep pushes 21 rendered strings into an anonymous array and runs a bare `expect(text).not.toContain('{{')` inside a loop. Vitest prints the array index, not which prompt broke, so a failure in a 20-prompt loop is a guessing game. The prompt-level value of this test is real (it is the only guard against a renamed variable silently rendering empty). -> Pair each rendered string with its name and pass the name as the assertion message, e.g. a `[name, text]` array and `expect(text, name).not.toContain('{{')`.
- [test-engineer] agent/extensions/verification/templates/verification-summary.jinja:50 `{% if testEngineer.smokeTest %}` (and the same pattern at the `codeReviewer.verificationStory` branch) guards arrays that `agent/extensions/verification/report.ts:195-215` always populates with a non-empty array - `smokeTestLines` always returns at least the Commands bullet. The `- none` fallbacks are unreachable and no test can reach them, so they read as covered surface that is not. -> Drop the two dead `{% else %} - none {% endif %}` branches in the template, or add a comment saying they are defensive only. Either way no test should be written against them.

#### Coverage Gaps (from test-engineer)
- `renderTemplate` with a syntactically invalid template: a test writing `{% if %}` to a temp path and asserting the throw message contains `cannot parse template`, the file path, and the underlying parse reason. The branch exists at `agent/extensions/lib/jinja.ts:19` and is currently unexercised.
- Template cache semantics: a test that writes template A, renders, then overwrites the same path with textually different template B and asserts the render still reflects A. This is the only way to fail if the `cache` Map is removed, and it pins the documented behaviour that a template edit mid-process is ignored.
- Undefined context variable: I verified `{{ missing }}` renders as the empty string, not an error. A test pinning that behaviour would catch a typo in a template variable name, which today silently produces a prompt with a blank section and every golden test still passes only because the goldens were captured from working code.
- `draftArgs` with `draft` set but `feedback` absent: the label becomes `revise spec` (`agent/extensions/sdd/workflows.ts:161` keys off `draft` alone) while `draft-prompt.jinja` keys off `draft and feedback`, so the prompt says "Compose a feature spec from this input." Production always passes both together (`agent/extensions/sdd/index.ts:150`), so this is unreachable today, but a test pinning the label/prompt agreement would stop the two conditions from drifting apart.
- Unreachable `- none` fallbacks for `testEngineer.smokeTest` and `codeReviewer.verificationStory` in `agent/extensions/verification/templates/verification-summary.jinja:50,66`. These are not testable as written because `report.ts` always passes a non-empty array; either delete them or stop treating them as a tested branch.

#### Smoke Test Result (from test-engineer)
- Commands: npx vitest run, npx vitest run  # repeated 3x, npx vitest run --sequence.shuffle, npx tsc --noEmit, npx oxlint --config .oxlintrc.jsonc, npx oxfmt --check "agent/extensions/**/*.ts" "tests/**/*.ts", git show main:agent/extensions/{sdd/prompts.ts,sdd/workflows.ts,verification/report.ts,verification/scope.ts} > /tmp/pre/  # pre-port sources, npx tsx@4 /tmp/pre/check.ts  # render pre-port code, diff against committed goldens, npx tsx@4 /tmp/smoke.ts  # drive agent/extensions/lib/jinja.ts error + cache paths, git status --porcelain  # confirm no repo writes from the review
- Suite: PASS. `npx vitest run` -> "Test Files 14 passed (14) / Tests 138 passed | 1 skipped (139)", duration 6.37s. Repeated 3x with identical results, and `--sequence.shuffle` also passed, so there is no order dependence or flakiness. The one skip is pre-existing and unrelated (`tests/mise-skill.test.ts:24 test.skipIf(!existsSync(SOURCE))`). Full gate also green: `npx tsc --noEmit` clean, `npx oxlint` clean, `npx oxfmt --check` "All matched files use the correct format", drift check "no drift".
- Manual: Happy path - proved the goldens are real pre-port truth, not regenerated output. I extracted main's pre-port `prompts.ts`, `workflows.ts`, `report.ts`, `scope.ts` into /tmp, re-rendered all 23 fixtures using the exact inputs from `tests/jinja-golden.test.ts`, and compared byte for byte against `tests/fixtures/sdd-golden/*.txt`. All 23 matched, including the trailing-newline-free shapes (last bytes of plan-prompt-full, research-verify, verification-summary and spec-template are ordinary characters, not 0x0a), so the loader's trailing-newline normalisation is genuinely pinned by exact equality. This is the strongest evidence in the review: the golden tests will fail on any behavioural drift from the hand-rolled prompts.

Error path - drove `agent/extensions/lib/jinja.ts` directly. Missing template: throws the raw `ENOENT: no such file or directory` (matches the existing test). Malformed template (`{% if %}`): throws `cannot parse template <path>: Unexpected token: CloseSt...`, confirming the untested catch branch works. Undefined variable: renders `a= b` - no error, so a typo in a template silently produces a blank prompt section. Cache probe: wrote `v={{ v }}`, rendered, then rewrote the same path to `CHANGED={{ v }}`; the second render returned `v=2`, i.e. the stale cached template, and an uncached implementation would have returned `CHANGED:2`. This is the proof that the cache test in `tests/jinja.test.ts` is tautological.

No CLI or server smoke was possible: the change is internal to pi extension code with no runnable entry point, and running the real pi agent needs model credentials. `tests/sdd.test.ts:1328` already exercises the workflow scripts through a stubbed agent, which is the closest thing to an end-to-e2e in this repo and it passes.

#### Verification Story (from code-reviewer)
- Tests reviewed: yes - read tests/jinja-golden.test.ts, tests/golden.ts, tests/jinja.test.ts and the diffs of tests/sdd.test.ts and tests/verification.test.ts before the sources. Goldens cover all 18 templates (16 sdd + verification-summary, both the present and the missing-commentAuditor branch) and all 4 planPrompt branches. Rather than trust them, I re-derived three fixtures from `main`'s pre-port code with an independent reconstruction (draft-revise, enrich-scope, discovery-synth-existing): all byte-identical, so the goldens are a real pre-port contract, not regenerated from the new renderers. Confirmed the new tests assert the right things: fence immunity in both the scanner and `demoteHeadings`, h1/h6 range edges, replace-in-place vs append with a single trailing newline, the four `- None` branches, and the two missing-agent fallbacks plus their REQUEST CHANGES verdict. Noted as a nit that no test forces a new `.jinja` file to get a golden.
- Build verified: yes - ran `mise run check`: `tsc --noEmit` clean, `oxlint --config .oxlintrc.jsonc` clean, `oxfmt --check` clean on 32 files, `vitest run` 14 files / 138 passed 1 skipped (the skip is pre-existing), `drift` clean, confirming no runtime writes under `agent/`. Also confirmed all 18 `.jinja` files are LF, end in a newline, and carry no trailing whitespace or CRLF, since no formatter covers them.
- Security checked: yes - no untrusted input reaches template source: specs, plans, discovery, memory, research claims and agent reports are passed as context values, so `{{`/`{%` in them cannot be re-parsed, and `tests/jinja.test.ts:20` pins verbatim substitution with no HTML escaping. Template paths are built only from code constants plus `import.meta.dirname`; no shell, no user-derived filesystem path. `@huggingface/jinja` is pinned exact `0.5.10` in package.json and package-lock.json, MIT, no install scripts and no transitive deps. No secrets in the diff. Nothing in this change adds I/O beyond reading tracked template files.

#### Comment Audit (from comment-auditor)
**MUST KILL**
- none
**Correctness**
- none
**Kept**
- agent/extensions/lib/jinja.ts:24 Keep-list item 2: behavior forced by an external dependency. Comment reads "// @huggingface/jinja strips one trailing newline from the source before / parsing, so a template ending in a loop or variable still renders one." Proof: node_modules/@huggingface/jinja/src/lexer.ts:124-129 in `preprocess()` does `if (template.endsWith("\n")) template = template.slice(0, -1)` before parsing, so the `rendered.slice(0, -1)` compensation at line 26 depends on a parser rule we cannot change. The earlier three-clause version that named a nonexistent `keep_trailing_newline` option was already trimmed in the current HEAD text, so nothing inaccurate remains.
**Skipped**
- agent/skills/** - out of scope by rule (verbatim copies of ../dotfiles/ai/.claude/skills/); no comments there judged.
- .pi/sdd/jinja-prompt-markdown-port/{spec,plan,discovery,deviations}.md and state.json - in scope as files but are prose SDD artifacts for the feature itself, not code; they contain no source comments to judge.
- agent/extensions/sdd/templates/*.jinja (18 files) and agent/extensions/verification/templates/verification-summary.jinja - read via `rg '\{#|//'`; zero Jinja comment tags and zero code comments, so nothing to judge.
- tests/fixtures/sdd-golden/*.txt (22 files) - rendered-output fixtures; grep found no comment constructs, nothing to judge.
- package-lock.json - generated lockfile, no comments.
- package.json - one added dependency line, no comment.
