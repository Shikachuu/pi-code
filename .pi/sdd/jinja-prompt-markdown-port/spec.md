# Port hand-rolled prompt and markdown templates to @huggingface/jinja

## Goal

Replace the hand-written string, split and regex handling of prompt and markdown templates in the TypeScript codebase with the official `@huggingface/jinja` package, so prompt text and markdown section handling are declarative templates instead of imperative string surgery, and so future prompt edits are made in one place (a `.jinja` file) rather than scattered template literals and line-index logic.

## Background

- `agent/extensions/sdd/prompts.ts` is the only real hand-rolled markdown/prompt engine.
  - `SPEC_TEMPLATE` (prompts.ts:1) and `PLAN_TEMPLATE` (prompts.ts:12) are template literals with `<placeholder>` text.
  - `headingLines` (prompts.ts:37) and `sectionBounds` (prompts.ts:46) do manual line scanning with a fence toggle and a `#{1,2}` regex.
  - `readSection` (prompts.ts:54) splits on `\n`, slices by index and trims.
  - `demoteHeadings` (prompts.ts:68) regex-replaces `^(#{1,5})\s` with one extra `#`.
  - `replaceSection` (prompts.ts:72) rebuilds the document from line arrays.
  - `validatePlan` (prompts.ts:80) does regex checks on section bodies.
  - `renderResearch` (prompts.ts:91) joins an array of heading/body pairs into markdown.
  - `planPrompt` (prompts.ts:107) and `implementPrompt` (prompts.ts:137) build XML-ish `<spec>`/`<plan>`/`<research>` blocks by interpolation.
- `agent/extensions/sdd/index.ts` consumes the section API: `requireDoc` (index.ts:102), `replaceSection(planDoc, 'Results', ...)` (index.ts:410), `replaceSection(planDoc, 'Verification', ...)` plus `demoteHeadings` (index.ts:456), and `validatePlan` (index.ts:367).
- `agent/extensions/sdd/workflows.ts` assembles prompts inline with template literals and ad-hoc tags: spec wrapping (workflows.ts:199, 212), `RESEARCH_SCRIPT` (workflows.ts:51) and the discovery/draft prompt that injects `SPEC_TEMPLATE` (workflows.ts:172).
- `agent/extensions/verification/report.ts` builds the verification markdown report from agent output; `agent/extensions/ask-user/review.ts` renders agent markdown into the TUI.
- Tests pin today's behaviour: `tests/sdd.test.ts:175-177` (`validatePlan`), `tests/sdd.test.ts:1172` (case-insensitive `## tasks` match), plus prompt-text assertions in `tests/system-prompt.test.ts`.
- No `@huggingface/jinja` dependency exists yet (`package.json`, `mise.lock`).
- Toolchain: mise tasks `typecheck`, `lint` (oxlint), `format`/`format:check` (oxfmt), `test` (vitest), `drift`; `mise check` runs all of them.

## Scope

- Migratable (true template rendering):
  - `SPEC_TEMPLATE`, `PLAN_TEMPLATE`, and the spec/plan/research/verification markdown bodies.
  - `planPrompt`, `implementPrompt`, and the inline workflow prompts in `workflows.ts` (draft spec, discovery probe/synth, research queries/gather/verify/report).
  - The markdown section handling used by the extension: section read, section replace, heading demotion, and the plan validation rules.
  - `renderResearch` and the verification report body.
- Mechanism (per user decisions):
  - Both parsing and prompt strings are ported.
  - `prompts.ts` keeps its exported API (`SPEC_TEMPLATE`, `PLAN_TEMPLATE`, `readSection`, `demoteHeadings`, `replaceSection`, `validatePlan`, `renderResearch`, `planPrompt`, `implementPrompt` and the input interfaces) so `sdd/index.ts` and tests need no import changes.
  - Templates live on disk in `agent/extensions/sdd/templates/` as `.jinja` files, loaded at runtime and rendered through `@huggingface/jinja`.
- Rules may be tightened where today's parsing is sloppy, with `prompts.ts`, `index.ts` and the affected tests updated to match.
- Add and pin `@huggingface/jinja`, refresh `mise.lock` if the install touches it.
- Extend `tests/` in the existing vitest style with cases for the migrated renders, including whitespace-sensitive output, missing headings, fenced code blocks containing `##` lines, and heading demotion.
- Keep `mise check` green.

## Non-goals

- Rewriting prompt wording, prompt content, or system prompt text. Only the rendering mechanism changes.
- Porting to any other template language or runtime. No Python, no Jinja CLI, no shelling out.
- Porting model-reply JSON parsing, git output parsing in `verification/scope.ts`, or slugify in `sdd/store.ts`.
- Touching `agent/agents/*.md`, `agent/APPEND_SYSTEM.md`, `agent/prompts/*.md`, `agent/skills/*/SKILL.md`. They are static assets with no template syntax.
- Changing the TUI rendering in `ask-user/review.ts` beyond what follows from a changed markdown shape.
- Upgrading unrelated dependencies, refactoring unrelated code, or reformatting untouched files.
- Changing prompt caching, ordering, agent routing, agentTypes, tiers or verification verdict logic.
- Committing, pushing or opening a PR.

## Expected behaviour

- `/spec`, `/plan`, `/implement`, `/verify` and the research and discovery workflows still run end to end and still read and write `spec.md`, `plan.md`, `research-N.md` the same way.
- `SPEC_TEMPLATE` and `PLAN_TEMPLATE` keep their current section structure, including the trailing headings, so generated docs stay comparable.
- `readSection` still returns a trimmed section body or `undefined` for a missing heading.
- `replaceSection` still replaces the body of an existing `## Heading` in place, appends the section when it is missing, and leaves the file ending in exactly one newline.
- `demoteHeadings` still shifts `#{1,5}` headings down one level and still leaves fenced code blocks alone.
- `validatePlan` still returns a list of human-readable errors for a plan missing tasks, acceptance criteria, or a backticked validation command, and still returns `[]` for a valid plan.
- Prompts keep their current wording and their XML-like block structure (`<spec>`, `<plan path=...>`, `<research path=...>`, `<discovery>`, `<existing-discovery>`).
- Tighter heading rules are allowed, but the loosened cases (case-insensitive heading match, headings other than `##` terminating a section) must either keep working or be an explicit, documented change with updated tests.
- Any prompt-text deviation from today's output is called out, not silently shipped.

## Constraints

- `prompts.ts` exports must keep their names, signatures and types.
- Templates are `.jinja` files resolved relative to the extension source, so `mise check` drift detection (`mise drift`) must not see new runtime writes under `agent/`. Template files are tracked, not generated.
- `@huggingface/jinja` is ESM-only upstream. The repo already runs ESM/TypeScript 7 on Node 24 (`mise.toml` pins node 24), so an ESM import is expected. A small interop shim is acceptable if the toolchain fights it.
- oxfmt only formats `agent/extensions/**/*.ts` and `tests/**/*.ts`; `.jinja` files are outside the formatter's reach and must be hand-kept to a consistent style.
- Jinja whitespace control differs from today's hand-trimmed output. Rendered prompts must be inspected against current output, not assumed.
- No new runtime dependency on network or filesystem beyond reading the tracked template files.

## Assumptions

- "Our TS codebase" means the ultimate-harness TypeScript sources under `agent/` and `tests/`, not `node_modules` and not generated output.
- "Manually parsed prompts and markdowns" means string/regex prompt assembly, section splitting and markdown template rendering, not runtime parsing of model JSON replies.
- `@huggingface/jinja` is the target and can express everything these templates need, including loops over research documents and the list rendering in `renderResearch`.
- Template loading is cheap enough to do at module load, and a small cache is fine.
- Markdown emitted for the TUI (`ask-user/review.ts`) is rendering, not parsing, and stays as is unless a shape change forces a touch.
- Tightening the heading rules is acceptable, but the shipped diff must document each intentional behaviour change.

## Open questions

- Should the tightened heading rules replace the current lenient ones, or keep case-insensitive matching for compatibility with existing `spec.md`/`plan.md` files on disk? `tests/sdd.test.ts:1172` currently asserts leniency.
- Should `validatePlan`'s checks move into a Jinja template that renders the error list, or stay in TypeScript and only consume Jinja-produced sections?
- Does `verification/report.ts` markdown come in scope for this pass, or stay as string assembly until a later change forces it?
- Is a `.jinja` file per prompt, or one per workflow family (for example `plan.jinja`, `implement.jinja`, `research.jinja`)?
- Should template files be embedded at build time instead of read at runtime, given the `mise drift` check?
