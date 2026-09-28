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
