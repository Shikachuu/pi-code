# Discovery

## Summary

Nine probes covered the current prompt and markdown machinery in `agent/extensions/`, the tests that pin it, the `@huggingface/jinja` package facts, lockfile and drift impact, runtime template loading, heading-rule leniency, and Jinja whitespace control.

Key outcomes:

- `agent/extensions/sdd/prompts.ts` is the only hand-rolled markdown engine. Its template literals, line scanner, and regex helpers are fully documented below with exact line references.
- Blast radius of a port is small. No test imports `SPEC_TEMPLATE`, `PLAN_TEMPLATE`, `planPrompt`, `implementPrompt`, `readSection`, `replaceSection` or `demoteHeadings`. Only `renderResearch` and `validatePlan` are imported (`tests/sdd.test.ts:16`).
- `@huggingface/jinja` is `0.5.10`, dual ESM/CJS (not ESM-only), `node>=18`, ships `.d.ts`. So the ESM interop shim the spec allows is probably unnecessary.
- Two constraints matter for design: no custom filters or tests can be registered, and `trim_blocks`/`lstrip_blocks` are on but `keep_trailing_newline` is not exposed. That pushes `validatePlan` regex rules to stay in TypeScript and pushes `.jinja` files to be read with `fs` and passed as strings.
- Lockfile work is required in `package-lock.json` (postinstall runs `npm ci`), not `mise.lock`. Tracked `.jinja` files under `agent/` are drift-safe because `mise drift` is a `git status --porcelain -- agent/` check.
- Lenient heading behaviour is pinned by exactly two assertions, both in one test at `tests/sdd.test.ts:1166-1173`, and no on-disk `spec.md`/`plan.md` exists in the repo or fixtures.

## Findings

### Probe: Exact current output of prompts.ts template literals

- `SPEC_TEMPLATE` is a 9-line string: `"# <Feature title>"` then headings `## Goal`, `## Background`, `## Scope`, `## Non-goals`, `## Expected behaviour`, `## Constraints`, `## Assumptions`, `## Open questions` with no blank lines and no trailing newline.
  - Evidence: `agent/extensions/sdd/prompts.ts:1-10`, `agent/extensions/sdd/prompts.ts:1` `# <Feature title>`, `agent/extensions/sdd/prompts.ts:10` `` ## Open questions` `` (backtick closes, no trailing `\n`)
- `PLAN_TEMPLATE` is `"# Plan: <Feature title>"` then `## Summary`, `## Decisions`, `- <decision>: <chosen option> - <why>`, `## Changes`, `- \`path/to/file\`: <what changes>`, `## Tasks`, `- [ ] 1. <task>`, `## Acceptance criteria`, `- <observable, testable criterion>`, `## Validation pipeline`, `- \`<command>\` - <what it proves>`, `## Risks`, `## Out of scope`. Backticks are escaped in source. No trailing newline.
  - Evidence: `agent/extensions/sdd/prompts.ts:12-25`, `agent/extensions/sdd/prompts.ts:16`, `agent/extensions/sdd/prompts.ts:21`
- `planPrompt` emits: `You are planning the implementation of feature "<slug>". Its files live in <dir>.` then blank line, `<spec>` block, blank, `<discovery>` block (fallback `No discovery was run.`), then if research non-empty `"\n"` + research blocks joined by blank line + `"\n"`, then if memory non-empty `"\n"` + memory + `"\n"`, then a trailing `"\n"` then the numbered `Work in this order:` block, blank line, `PLAN_TEMPLATE`, blank line, and step 5.
  - Evidence: `agent/extensions/sdd/prompts.ts:113-147`, `agent/extensions/sdd/prompts.ts:118`, `agent/extensions/sdd/prompts.ts:129`, `agent/extensions/sdd/prompts.ts:141`
- `implementPrompt` emits `Implement feature "<slug>" by following its plan.`, blank, `<plan path="<planPath>"> ... </plan>`, blank, `Reference files (read them when you need detail): <docs joined by ', '>`, blank, then 6 bullet rules ending with the `sdd_complete` line.
  - Evidence: `agent/extensions/sdd/prompts.ts:154-169`, `agent/extensions/sdd/prompts.ts:155-158`, `agent/extensions/sdd/prompts.ts:167`
- No test pins `planPrompt`/`implementPrompt` output, and no test imports `SPEC_TEMPLATE`/`PLAN_TEMPLATE`; only `workflows.ts` consumes `SPEC_TEMPLATE`.
  - Evidence: `rg -n 'planPrompt|implementPrompt' tests/ -> no matches`; `rg -n 'SPEC_TEMPLATE|PLAN_TEMPLATE' -> agent/extensions/sdd/workflows.ts:1,172 and prompts.ts:1,12,141 only`
- `SPEC_TEMPLATE` is interpolated into the draft prompt in `workflows.ts`, so its whitespace is part of a live prompt.
  - Evidence: `agent/extensions/sdd/workflows.ts:172`

### Probe: Section API call sites and behavior contracts

- `readSection` splits on `\n`, finds the section by exact `## heading` (case-insensitive, trailing whitespace trimmed on the heading text) and returns the joined body trimmed; returns `undefined` when the heading is absent. It does not match `# ` (level 1) headings.
  - Evidence: `agent/extensions/sdd/prompts.ts:37-52`, `agent/extensions/sdd/prompts.ts:46-52`, `agent/extensions/sdd/prompts.ts:54-63`
- A section is terminated by the next line that `headingLines` marks as a heading, i.e. any `#` or `##` line outside a fence. Level 3+ headings do NOT terminate a section, and an unterminated final section extends to end of file.
  - Evidence: `agent/extensions/sdd/prompts.ts:39` (`/^(#{1,2})\s+(.*?)\s*$/`), `agent/extensions/sdd/prompts.ts:49-50`
- Fence handling: a line matching `/^\s*```/` toggles `fenced` BEFORE the heading test, so the opening ``` line and everything inside (including `##` lines) are ignored. Only triple backticks toggle; no `~~~` support and no fence-length/language tracking.
  - Evidence: `agent/extensions/sdd/prompts.ts:38-42`
- `demoteHeadings`: `/^(#{1,5})\s/gm` -> hashes + `'# '`, so `## X` -> `### X` and `##### X` -> `###### X`. It has NO fence awareness.
  - Evidence: `agent/extensions/sdd/prompts.ts:65-69`
- `replaceSection`: builds `block = ['## ' + heading, '', body, '']`; if the heading is missing it APPENDS `[...lines, '', ...block]` (after `trimEnd` on the whole doc); if present it splices the block between `bounds.start` and `bounds.end`, then `.trimEnd() + '\n'`. An existing trailing `## Next` section is preserved after the block.
  - Evidence: `agent/extensions/sdd/prompts.ts:72-78`
- `validatePlan` returns human-readable error strings using `readSection`, so it inherits case-insensitive matching and fence rules. Three checks: `## Tasks` needs `/^\s*- \[[ x]\]/m`, `## Acceptance criteria` needs `/^\s*[-*\d]/m`, `## Validation pipeline` needs ``/`[^`]+`/``. Missing section and failed regex push the same message.
  - Evidence: `agent/extensions/sdd/prompts.ts:80-89`
- Call sites in `sdd/index.ts`: `validatePlan` at `index.ts:367`; `replaceSection(planDoc, 'Results', ...)` at `index.ts:410`; `replaceSection(planDoc, 'Verification', ...)` plus `demoteHeadings` at `index.ts:456`. `demoteHeadings` is imported at `index.ts:12` and used only at `index.ts:456`.
  - Evidence: `agent/extensions/sdd/index.ts:12,17,18`, `agent/extensions/sdd/index.ts:367`, `agent/extensions/sdd/index.ts:408-411`, `agent/extensions/sdd/index.ts:456`
- `readSection` is NOT called from `sdd/index.ts`; it is used internally by `validatePlan` and its returned undefined-vs-empty-string shape matters (empty section body is falsy and counts as missing).
  - Evidence: `rg over agent/ and tests/: readSection appears only at agent/extensions/sdd/prompts.ts:54,82,84,86`
- `requireDoc` is unrelated to `readSection`: it is a `readDoc` plus throw-on-missing guard.
  - Evidence: `agent/extensions/sdd/index.ts:102-106`, `agent/extensions/sdd/index.ts:162,178,208,226`
- Tests pinning today's behavior: `validatePlan(VALID_PLAN) === []` and a plan with no criteria yields errors (`tests/sdd.test.ts:175-177`); case-insensitive `## tasks` still validates (`tests/sdd.test.ts:1172`). Only `renderResearch` and `validatePlan` are imported by tests from `prompts.ts`.
  - Evidence: `tests/sdd.test.ts:16`, `tests/sdd.test.ts:175-177`, `tests/sdd.test.ts:1171-1172`

### Probe: Inline prompt assembly in workflows.ts

- Spec wrapping happens in three places: `enrichArgs` builds one `<request>...</request>` block reused by all three enrich prompts (scope/repo/questions).
  - Evidence: `agent/extensions/sdd/workflows.ts:132`, `:135`, `:140`, `:145`
- `withMemory` appends memory as a raw `\n\n${memory}` suffix, no tag wrapping.
  - Evidence: `agent/extensions/sdd/workflows.ts:128`
- `draftArgs` builds `<request>`, `<enrichment>`, optional `<user-answers>`, then two branches: revise (`<draft>` + `<feedback>`) or the fixed string `Compose a feature spec from this input.`, and finally interpolates `SPEC_TEMPLATE` between `Use this markdown template:` and the slug instruction.
  - Evidence: `agent/extensions/sdd/workflows.ts:160`, `:161-164`, `:165`, `:172`, `:1`
- `discoveryArgs` wraps spec in `<spec>` for all four prompt slots; plan and probe also use `withMemory`, synth optionally adds `<existing-discovery>` plus a merge instruction, `probe.web` is a separate non-tagged `WEB_TOOLS` string.
  - Evidence: `agent/extensions/sdd/workflows.ts:190`, `:212`, `:213`, `:125`, `:216`
- `researchArgs` context = `<spec>` plus optional `<discovery>`; queries and report use `context`, gather starts with `WEB_TOOLS`, verify is a plain untagged string; topic is interpolated twice (queries, report) and `question: topic` is a plain data field.
  - Evidence: `agent/extensions/sdd/workflows.ts:232`, `:234`, `:236`, `:241`, `:246`, `:253`
- `RESEARCH_SCRIPT` and `DISCOVERY_SCRIPT` are template literals of the whole workflow script, containing escaped `\n` and extra tags built at runtime: probe prompt gets `'\n\n<probe>\n' + JSON.stringify(p, null, 2) + '\n</probe>'` plus optional `'\n\n' + args.probe.web` for `kind==='web'`; synth gets `'\n\n<probe-results>\n' + JSON.stringify(results, null, 2) + '\n</probe-results>'`; research gather appends `'\n\nQuery: ' + q`, verify appends `'\n\nSOURCES JSON:\n' + JSON.stringify(sources)`, report appends `'\n\nSUPPORTED CLAIMS JSON:\n' + JSON.stringify((verdict && verdict.supported) || [])`.
  - Evidence: `agent/extensions/sdd/workflows.ts:51`, `:64`, `:67`, `:71`, `:40`, `:48`
- Only two tag shapes use JSON pretty-printing: `<enrichment>` and `<probe-results>`; `<probe>`, `<spec>`, `<request>`, `<discovery>`, `<existing-discovery>`, `<draft>`, `<feedback>`, `<user-answers>` are plain string interpolation.
  - Evidence: `agent/extensions/sdd/workflows.ts:160`, `:48`, `:40`, `:67`, `:71`

### Probe: renderResearch and verification report shape

- `renderResearch` produces a fixed 8-heading markdown doc: `# Research: <question>`, then `## Question`, `## Summary`, `## Findings`, `## Implications for this feature`, `## Recommendation`, `## Open questions`, `## Sources`; all blocks joined with a blank line (`\n\n`). One document per report, not one per research doc.
  - Evidence: `agent/extensions/sdd/prompts.ts:91-105`, `:107-124` (list items are `- ${i}` joined by `\n`, empty lists become `- None`), `:96` (`${f.claim} (${f.sources.join(', ')})`), `:92` (sources de-duped via `[...new Set(report.findings.flatMap(f => f.sources))]`)
- Multiple research docs are handled elsewhere: `planPrompt` takes research as `{path, content}[]` and wraps each in `<research path="...">` blocks joined by `\n\n`.
  - Evidence: `agent/extensions/sdd/prompts.ts:118-124`
- `verification/report.ts` does NOT build markdown by simple string assembly like `renderResearch`. It is heavily branchy imperative code with its own helpers `bullet()`, `section()`, `findingLine()`, `auditLine()` joining parts with `\n\n`.
  - Evidence: `agent/extensions/verification/report.ts:166-183`, `:185-200`, `:203-214`, `:216-247`, `:249`, `:119-152`
- Porting `report.ts` means porting its control flow, not just its string joins. The `->` vs `-` arrow choice, `[all]` attribution, and severity ordering would have to move into filters/expressions or stay in TS as pre-rendered data.
  - Evidence: `agent/extensions/verification/report.ts:85-92`, `:170-177`, `:95-112`

### Probe: Tests pinning prompt text and section leniency

- Whitespace/shape-sensitive prompt text assertions are few and mostly regex/prefix based, so a Jinja port likely survives them if block tags keep a single leading newline.
  - Evidence: `tests/sdd.test.ts:274` (`/<existing-discovery>\nOLD/`), `tests/sdd.test.ts:283` (`/<memory>m<\/memory>/`), `tests/sdd.test.ts:519` (`/<feedback>\nmention limits/`)
- `validatePlan` error text is asserted by keyword, not exact string.
  - Evidence: `tests/sdd.test.ts:175-181` (`/checkbox/`, `/Acceptance criteria/`, `/backticks/`, `errors.length` 3), `tests/sdd.test.ts:177`
- `renderResearch` tests pin heading text exactly and one blank-line-after-heading pattern. This is the most whitespace-fragile assertion in the suite.
  - Evidence: `tests/sdd.test.ts:184-210` (`toContain` over the seven `##` headings), `:208` (`/## Open questions\n\n- None/`), `:209` (dedup count on `'- https://a'`)
- Section leniency is pinned twice: fenced code blocks containing `#`/`##` lines are ignored, and heading match is case-insensitive.
  - Evidence: `tests/sdd.test.ts:1164-1172` (test `plan sections ignore headings inside code fences`, injecting ` ```bash\n# run everything\nmise run test\n``` `), `:1171`, `:1172`, `:47-57` (`VALID_PLAN` fixture)
- `tests/system-prompt.test.ts` contains no prompt-text assertions at all.
  - Evidence: `tests/system-prompt.test.ts` is 25 lines; only assertion is `tests/system-prompt.test.ts:20` `expect(session.systemPrompt.length).toBeGreaterThan(0)`
- Other `toContain` assertions in `sdd.test.ts` are unrelated to prompt/markdown templates.
  - Evidence: `tests/sdd.test.ts:569`, `:1140-1145`
- Only two modules under test import the template API directly, so the blast radius of `prompts.ts` export changes is limited.
  - Evidence: `tests/sdd.test.ts:16` `import { renderResearch, validatePlan } from '../agent/extensions/sdd/prompts.ts'`; no tests import `readSection`, `replaceSection`, `demoteHeadings`, `planPrompt`, `implementPrompt`, `SPEC_TEMPLATE`, `PLAN_TEMPLATE`

### Probe: @huggingface/jinja package facts

- Latest version is `0.5.10` (dist-tag latest), package name `@huggingface/jinja`.
  - Evidence: `npm view @huggingface/jinja dist-tags -> { latest: '0.5.10' }`; `npm view @huggingface/jinja version -> 0.5.10`
- It is NOT ESM-only: it ships dual ESM/CJS via exports map, with bundled TypeScript declarations.
  - Evidence: `type = 'module'`; `main = './dist/index.cjs'`; `exports['.'] = { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' }`; `index.d.ts` exports `Template`, `Environment`, `Interpreter`, `tokenize`, `parse`
- Node engine requirement is `node >=18`, so the repo's Node 24 pin is satisfied.
  - Evidence: `npm view @huggingface/jinja engines -> { node: '>=18' }`
- Public API is minimal: `new Template(source).render(context)` and `.format({indent})`. Parsing primitives (`tokenize`, `parse`, `Environment`, `Interpreter`) are also exported.
  - Evidence: `constructor(template: string); render(items?: Record<string, unknown>): string; format(options?: { indent: string | number }): string;`
- Built-in filters cover what this port needs: `trim`, `indent`, `join`, `length`, `replace`, `lower`, `upper`, `first`, `last`, `sort`, `unique`, `reverse`, `map`, `selectattr`, `rejectattr`, `items`, `list`, `string`, `int`, `float`, `abs`, `bool`, `capitalize`, `title`, plus `undefined`/`null`/`boolean`.
  - Evidence: `grep -oE 'case "[a-z_]+"' package/dist/index.js`
- Tests available: `defined`, `undefined`, `eq`, `ne`, `in`, `odd`, `even`. No public API to register custom tests: `Environment.tests` is a `ReadonlyMap` built from a private static `TESTS`.
  - Evidence: `grep of index.js: "defined" "eq" "even" "in" "ne" "odd" "undefined"`; `package/dist/runtime.d.ts:137-145`
- Control flow available: `for`, `if`, `set`, `filter` blocks, `macro` (CallStatement with `callerArgs`), `call`, `break`, `continue`. No `include`/`extends`/file-loading statements, so multi-file composition needs manual concatenation.
  - Evidence: `grep -oE '(case|equals)\("[a-z_]+"\)' index.js`; `package/dist/ast.d.ts:148-156`, `:212-217`; grep of `ast.d.ts` literal tags: block, extends, filter, for, if, import
- Whitespace control: `{%-`/`-%}` markers exist, but `trim_blocks`/`lstrip_blocks` options are only on the low-level `tokenize()`, not on `Template`'s constructor.
  - Evidence: `grep -oE '"[-+"]"' package/dist/index.js -> "-" "+"`; `package/dist/lexer.d.ts:46-53`; `package/dist/index.d.ts: constructor(template: string);`

### Probe: Install and lockfile impact

- Repo uses both: `package-lock.json` (lockfileVersion 3) is the npm lock and `mise.lock` only locks mise tools (node 24.21.0, pi 0.87.0). Adding a dep needs a `package-lock.json` entry; `mise.lock` is unaffected.
  - Evidence: `package-lock.json:1-3`; `mise.lock:1-2`, `:4-8`; `package-lock.json:6-10`
- The mise postinstall hook runs `npm ci`, which fails if `package.json` and `package-lock.json` are out of sync, so the lock must be regenerated in the same change. The `better-sqlite3` rebuild is separate and unaffected.
  - Evidence: `mise.toml:10-11` `postinstall = "npm ci && npm rebuild better-sqlite3 --ignore-scripts=false"`; `package-lock.json:4264-4266`; `package-lock.json:7128`
- `@huggingface/jinja` reports no runtime dependencies, so it adds a leaf entry (version + resolved + integrity) to `package-lock.json` only.
  - Evidence: `npm view @huggingface/jinja version -> 0.5.10`
- `mise drift` only checks that runtime did not dirty tracked files under `agent/`, so adding tracked `.jinja` template files there is drift-safe as long as nothing writes them at runtime.
  - Evidence: `mise.toml:48-51`

### Probe: Runtime template loading and path resolution

- No extension source uses `import.meta.url` today; runtime file IO in `agent/extensions` is all cwd-relative to the user's project.
  - Evidence: `rg 'import\.meta\.url|import\.meta\.dirname|fileURLToPath' agent/ -> no matches under agent/`; `agent/extensions/sdd/index.ts:217`; `agent/extensions/sdd/store.ts:69,109`; `agent/extensions/sdd/memory.ts:37`
- Tests and repo-root resolution already rely on `import.meta.dirname`, so the same pattern is available for `prompts.ts`.
  - Evidence: `tests/verification.test.ts:17`; `tests/helpers.ts:7`; `tests/system-prompt.test.ts:11`
- `mise drift` only fails on uncommitted/untracked changes under `agent/`, so reading tracked `.jinja` files at runtime is safe. oxfmt globs only `**/*.ts`.
  - Evidence: `mise.toml [tasks.drift]`; `mise.toml [tasks.check]`; `mise.toml [tasks.format]`
- Recommended resolution: use `import.meta.dirname` in `agent/extensions/sdd/prompts.ts` joined with `templates`, load and cache at module load; independent of `ctx.cwd`.
  - Evidence: `mise.toml` drift compares working tree, not artifacts; `mise.toml [env] PI_CODING_AGENT_DIR = {{config_root}}/agent` is an alternative anchor

### Probe: Heading rule tightening options

- No `spec.md`, `plan.md` or `research-N.md` files exist in the repo or test fixtures. The only lenient-heading consumers are in-memory test strings.
  - Evidence: `fd -e md -E node_modules .` returns only `README.md`, `agent/AGENTS.md`, `agent/agents/*.md`, `agent/prompts/review.md`, `agent/skills/**/*.md`; `rg -ni '^#{1,6} ' --glob '*.md' -g '!node_modules' . | rg -i 'tasks|acceptance|results|verification'` only matches `agent/skills/mise/*.md`
- Case-insensitive `## tasks` leniency is pinned by exactly one test line.
  - Evidence: `tests/sdd.test.ts:1172`; `agent/extensions/sdd/prompts.ts:41`, `:48`
- Code-fence leniency is pinned by one test that also contains the case-insensitive assertion in the same body.
  - Evidence: `tests/sdd.test.ts:1166-1173`; `agent/extensions/sdd/prompts.ts:37-43`
- Non-`##` terminators: any `#` or `##` heading other than the matched one ends a section, so a `### Tasks` under `## Plan` is not found. No fixture asserts this.
  - Evidence: `agent/extensions/sdd/prompts.ts:44-51`, `:39`
- `demoteHeadings` has no direct unit test; it is exercised only through `index.ts` Results/Verification replacement, so tightening it is low risk but untested today.
  - Evidence: `agent/extensions/sdd/prompts.ts:68-70`; `rg -n 'demoteHeadings' tests/ -> no matches`
- `validatePlan` required sections are Tasks, Acceptance criteria, Validation pipeline, and the error strings hardcode the `## ` prefix.
  - Evidence: `agent/extensions/sdd/prompts.ts:80-89`; `tests/sdd.test.ts:175-177`

### Probe: Jinja whitespace control and testing patterns

- `@huggingface/jinja` latest is `0.5.10`, dual ESM/CJS published, `engines node>=18`; its own scripts use oxfmt, eslint and vitest.
  - Evidence: `https://registry.npmjs.org/@huggingface/jinja/latest -> "version":"0.5.10", "type":"module", "exports":{...}, "engines":{"node":">=18"}, "scripts": {..."test":"vitest run"...,"format":"oxfmt ."}`
- Rendering a template is string-in: `new Template(templateString)` then `template.render(items)`. There is no file-loading helper and no `addFilter`/custom-test API in the public typings.
  - Evidence: `https://unpkg.com/@huggingface/jinja@0.5.10/dist/index.d.ts -> export declare class Template { parsed: Program; constructor(template: string); render(items?: Record<string, unknown>): string; format(options?: {indent: string | number}): string; }` and `export { Environment, Interpreter, tokenize, parse };`; `https://raw.githubusercontent.com/huggingface/huggingface.js/main/packages/jinja/README.md`
- Whitespace control: the `-` markers are supported and the library is configured with `trim_blocks` and `lstrip_blocks`. The constructor takes no options, so `keep_trailing_newline` is not exposed and a single trailing newline is stripped from the output.
  - Evidence: `https://github.com/huggingface/huggingface.js/pull/352 -> "Do trim_blocks=True, lstrip_blocks=True (needed by HuggingFaceH4/zephyr-7b-beta)"`; `https://huggingface.co/docs/transformers/chat_templating_writing`; `https://jinja.palletsprojects.com/en/latest/templates/`; `https://unpkg.com/@huggingface/jinja@0.5.10/dist/index.d.ts`
- There is no supported way to register a custom filter or test. `Environment` exposes `tests: ReadonlyMap<...>` built from a private static `TESTS` table, filters live in per-type private `_builtins`, and `setupGlobals(env)` is the only extension hook.
  - Evidence: `https://unpkg.com/@huggingface/jinja@0.5.10/dist/runtime.d.ts -> export declare class Environment { ... private static readonly TESTS; tests: ReadonlyMap<...>; ... }`; same file `export declare function setupGlobals(env: Environment): void;` and `private applyFilter;`; same file `declare class StringValue extends RuntimeValue<string> { type: string; private _builtins?; get builtins(): Map<string, AnyRuntimeValue>; }`
- Consequence: a regex validator (`validatePlan`) cannot be injected as a Jinja filter/test without patching the library. It should stay in TypeScript, or the check must use built-ins only. Likewise `.jinja` files must be read with `fs` and passed as a string.
  - Evidence: `https://unpkg.com/@huggingface/jinja@0.5.10/dist/index.d.ts`; `https://raw.githubusercontent.com/huggingface/huggingface.js/main/packages/jinja/README.md`

## Pre-answered questions

- **Latest version / package identity.** `@huggingface/jinja` `0.5.10`, latest dist-tag. Evidence: `npm view @huggingface/jinja dist-tags -> { latest: '0.5.10' }`.
- **ESM-only status.** Not ESM-only. It is dual ESM/CJS (`type: module`, `exports` with `import` and `require`). Evidence: `https://registry.npmjs.org/@huggingface/jinja/latest`. So the interop shim the spec allows is likely unnecessary.
- **Node requirement.** `node >=18`. Repo pins Node 24. Evidence: `npm view @huggingface/jinja engines -> { node: '>=18' }`.
- **Do we need `mise.lock` changes?** No. `mise.lock` only pins node 24.21.0 and pi 0.87.0. Evidence: `mise.lock:4-8`.
- **Which lockfile must change?** `package-lock.json`, and in the same change, because the postinstall hook runs `npm ci`. Evidence: `mise.toml:10-11`.
- **Is reading `.jinja` files at runtime safe under `mise drift`?** Yes. Drift is `git status --porcelain -- agent/`, a working-tree check. Tracked, unmodified template files pass. Only runtime writes or untracked files fail. Evidence: `mise.toml:48-51`.
- **How should template paths resolve?** `import.meta.dirname` in `agent/extensions/sdd/prompts.ts` joined with `templates`. Precedent: `tests/verification.test.ts:17`, `tests/helpers.ts:7`. No `import.meta.url` usage exists in `agent/` today, so this would be the first.
- **Does oxfmt touch `.jinja` files?** No. `mise.toml [tasks.format]` globs only `agent/extensions/**/*.ts` and `tests/**/*.ts`.
- **Are there on-disk `spec.md`/`plan.md` relying on lenient headings?** No. None exist in the repo or fixtures. Evidence: `fd -e md -E node_modules .`, plus the `rg` heading sweep that only hit `agent/skills/mise/*.md`.
- **Is case-insensitive heading matching pinned?** Yes, by exactly one assertion: `tests/sdd.test.ts:1172`. Fence leniency is pinned by `tests/sdd.test.ts:1166-1173` in the same test. Both can be updated deliberately since no fixture depends on them.
- **Can `validatePlan` regex rules move into a Jinja template?** Not with custom tests. The library exposes no public API to register tests or filters (`Environment.tests` is a `ReadonlyMap` from a private static `TESTS`; filters are private per-type `_builtins`). Evidence: `https://unpkg.com/@huggingface/jinja@0.5.10/dist/runtime.d.ts`. Answer to the open question: keep `validatePlan` in TypeScript.
- **Does `verification/report.ts` belong in this pass?** The spec lists it as in scope, but the probe shows it is far more branchy than `prompts.ts` and contains logic (`attribution()`, severity ordering, dedupe, arrow choice) that cannot move into a template. Evidence: `agent/extensions/verification/report.ts:85-92`, `:119-152`, `:170-177`, `:185-247`. Recommendation: defer, or port only the string assembly.
- **One `.jinja` file per prompt or per workflow family?** The evidence favours per-prompt files. There are at least 12 distinct prompt strings (2 templates, 2 prompts, 3 enrich, 4 draft, 4 discovery, 6 research) plus runtime-composed variants in `DISCOVERY_SCRIPT`/`RESEARCH_SCRIPT` (`:40`, `:48`, `:64`, `:67`, `:71`). Grouping by family would force a large conditional surface. Note the library has no `include`/`extends`, so composition would be manual concatenation anyway. Evidence: `agent/extensions/sdd/workflows.ts:132-253`, `:40-71`.
- **Build-time embedding vs runtime read?** Runtime read is safe. Drift compares the working tree, not artifacts, and there is no build step in `mise.toml`. Evidence: `mise.toml [tasks.drift]`, `[tasks.check]`, `[tasks.format]`. Open risk: if the package is ever bundled, `import.meta.dirname` points at the build dir.
- **What is the test blast radius for prompt text?** Narrow. `tests/system-prompt.test.ts` has no prompt-text assertions (single `length > 0` at line 20). `tests/sdd.test.ts:274`, `:283`, `:519` pin single-newline after an opening tag via regex. `tests/sdd.test.ts:184-210` pins `renderResearch` heading text and `/## Open questions\n\n- None/`. Only `renderResearch` and `validatePlan` are imported from `prompts.ts` (`tests/sdd.test.ts:16`).

## Remaining gaps

- No probe read `workflows.ts` prompt bodies beyond the `SPEC_TEMPLATE` interpolation, and none checked whether `sdd/index.ts` prepends anything to `draftArgs`/`discoveryArgs`/`researchArgs` prompts, so the final prompt may have extra upstream wrapping.
- The exact current whitespace of rendered output was not measured. Risk against `tests/sdd.test.ts:208` is an inference. A one-off node script diffing rendered vs current prompt text after install would close this.
- `{{` collisions in prompt text, and actual rendered newline behaviour for `for`-loops and block tags under `trim_blocks`/`lstrip_blocks`, were not empirically captured.
- Whether `Environment`/`Interpreter` can be used to register custom filters in a supported way is unconfirmed, though the typings suggest no. This matters only if `validatePlan` rules were to move into a template.
- No probe ran vitest, so current pass state and any pre-existing failures are unknown.
- `demoteHeadings` and `replaceSection` have no direct unit tests today, so behaviour changes there are untested. The fence-inside-`demoteHeadings` gap is real and uncovered.
- `index.ts:440-470` was not read in full, so whether `demoteHeadings` output can contain fences at the `Verification` call site is unverified.
- Not verified: `tsconfig` include/exclude for non-TS assets (would `templates/` be packaged?), whether `mise.lock` is tracked, whether an existing transitive copy of `@huggingface/jinja` sits in `node_modules`, and whether oxlint/oxfmt need config for the new dep.
- `ask-user/review.ts` (126 lines) was not read. The spec says it is rendering-only, so this is low priority.
- Built-in filter and test names came from grep of the tarball, not from the docs. `match` availability in particular is unconfirmed.
- `renderResearch`/verification report output is not pinned by any known exact test, so whitespace blast radius there is unquantified.

## Relevant files

- `agent/extensions/sdd/prompts.ts` - the only hand-rolled markdown/prompt engine. Templates at `:1` and `:12`; `headingLines` `:37`; `sectionBounds` `:46`; `readSection` `:54`; `demoteHeadings` `:68`; `replaceSection` `:72`; `validatePlan` `:80`; `renderResearch` `:91`; `planPrompt` `:107`; `implementPrompt` `:137`.
- `agent/extensions/sdd/workflows.ts` - inline prompt assembly. `RESEARCH_SCRIPT` `:51`, `DISCOVERY_SCRIPT` runtime tag concatenation `:40`, `:48`, `:64`, `:67`, `:71`; `WEB_TOOLS` `:125`; `withMemory` `:128`; `enrichArgs` `:132-145`; `draftArgs` `:160-172`; `discoveryArgs` `:190-216`; `researchArgs` `:232-253`.
- `agent/extensions/sdd/index.ts` - section API consumer. imports `:12`, `:17`, `:18`; `requireDoc` `:102-106`; `validatePlan` `:367`; `replaceSection(..., 'Results', ...)` `:408-411`; `replaceSection(..., 'Verification', ...)` + `demoteHeadings` `:456`.
- `agent/extensions/verification/report.ts` - verification markdown. `attribution()` `:85-92`; `auditToFindings` `:95-112`; `mergeFindings` `:119-152`; `bullet`/`section` `:166-183`; severity filtering `:185-200`; conditional sections `:203-247`; `parts.join('\n\n')` `:249`.
- `agent/extensions/ask-user/review.ts` - TUI markdown rendering, 126 lines, out of scope unless shape changes.
- `agent/extensions/sdd/store.ts` - `readFileSync` usage `:69`, `:109`; slugify explicitly out of scope.
- `agent/extensions/sdd/memory.ts` - `readFileSync(file)` `:37`.
- `tests/sdd.test.ts` - the only prompt-adjacent test module. import `:16`; `VALID_PLAN` fixture `:47-57`; `validatePlan` assertions `:175-181`; `renderResearch` assertions `:184-210`; prompt regexes `:274`, `:283`, `:519`; fence and case-insensitivity `:1164-1173`.
- `tests/system-prompt.test.ts` - 25 lines, no prompt-text assertions.
- `tests/verification.test.ts` - `import.meta.dirname` precedent `:17`.
- `tests/helpers.ts` - `import.meta.dirname` precedent `:7`.
- `package.json`, `package-lock.json` (lockfileVersion 3) - dependency and lock change target.
- `mise.lock` - mise tool pins only; no change needed.
- `mise.toml` - `postinstall` `:10-11`; `tasks.drift` `:48-51`; `tasks.check`; `tasks.format` globs.
- New: `agent/extensions/sdd/templates/*.jinja` - to be created, tracked, read at runtime via `import.meta.dirname`.
