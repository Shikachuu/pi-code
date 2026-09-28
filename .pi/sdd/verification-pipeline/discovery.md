# Discovery

## Summary

The verification pipeline port to pi-dynamic-workflows is technically feasible. Core capabilities are present: `parallel()` orchestration for three concurrent agents, `agent()` calls with schema validation, command registration via extensions, and Node.js built-in test infrastructure. The codebase establishes patterns for workflows, prompts, and test isolation.

Key enabler: `parallel()` takes an array of thunks, runs them concurrently, returns Promise<Array<unknown | null>> preserving input order. This directly supports fanning out code-reviewer, test-engineer, and comment-auditor agents in parallel, with synthesis after awaiting the merged results.

Gaps are implementation gaps, not architectural ones: no existing git diff computation, no scope descriptor builders, no test suite auto-detection logic, and no existing multi-agent coordinator. These are necessary additions, not blockers.

## Findings

### Probe: Parallel agent orchestration API

**Claim: parallel() signature and core behavior**

Evidence:

- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/capability-details.md`: Signature: `parallel(thunks) => Promise<Array<unknown | null>>`
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/runtime.md`: `parallel()` takes thunks, runs independent work, and preserves input order. Await the whole array before whole-set synthesis.
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/capability-details.md`: Constraint: requires functions rather than promises
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/capability-details.md`: Constraint: result order matches input order
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/capability-details.md`: Constraint: recoverable thunk failures become null; nonrecoverable failures throw

**Claim: How parallel() fans out agents and merges results in practice**

Evidence:

- `agent/extensions/sdd/workflows.ts:20-28` ENRICH_SCRIPT: `const results = await parallel([ () => agent(...), () => agent(...), () => agent(...) ]); return { scope: results[0], repo: results[1], questions: results[2] }`
- `agent/extensions/sdd/workflows.ts:48-58` DISCOVERY_SCRIPT: `const found = await parallel(probes.map((p, i) => () => agent(...))); const results = probes.map((probe, i) => ({ probe, result: found[i] }))`
- `agent/extensions/sdd/workflows.ts:60-66` RESEARCH_SCRIPT: `const gathered = await parallel(queries.map((q, i) => () => agent(...)))`
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/review.md`: Does topology match dependencies: thunks for independent parallel work, stages for per-item pipelines, barriers before whole-set synthesis?

**Claim: Error handling and null semantics**

Evidence:

- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/runtime.md`: Call `agent(prompt, { label, schema? })`; it returns text, a schema-validated value, or recoverable `null`. Nonrecoverable limit, validation, and budget failures throw.
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/lifecycle.md` (mentioned in debugging.md): Coverage silently disappears — `null` results were filtered before IDs were ledgered
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/invariants` (SKILL.md): Pair ordered results with stable work IDs before filtering. ... Treat recoverable `null` as missing coverage and report it.

### Probe: Agent call options and schema

**Claim: agent() accepts prompt (string) plus options object with label, tier, schema, model, agentType, thread, isolation, keepWorktree, cwd, thinking, timeoutMs, and retries**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/node_modules/@quintinshaw/pi-dynamic-workflows/dist/workflow.d.ts:AgentOptions` interface
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/workflows.ts:11-23` (DISCOVERY_SCRIPT with agent() calls)

**Claim: Routing priority: explicit model > agentType model > tier > phase model > inherited main model > implicit medium > session default**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/runtime.md:Routing` and support section
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/workflows.ts:9-10` (tier:'small' examples)

**Claim: Schemas are JSONSchema objects that shape and validate agent responses; built using helper pattern obj(properties, required) with str and strList primitives**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/workflows.ts:95-102` (schema builder helpers)
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/workflows.ts:104-107` (FINDINGS_SCHEMA example)
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/workflows.ts:135` (obj({ goal: str, inScope: strList, ... }))

**Claim: Schema noncompliance throws and bypasses retries; agent returns text, validated value, or recoverable null**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/runtime.md:Data` and failure section
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/node_modules/@quintinshaw/pi-dynamic-workflows/dist/workflow.d.ts:AgentOptions` generic type TSchemaDef

**Claim: thread parameter re-enters named subagent conversation sequentially; enables parent→child→parent handoff patterns with shared transcript across phases**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/runtime.md:Data` and failure section (threading explanation)

### Probe: Verification report structure

**Claim: Agent report base schema: each agent returns Critical/Important/Nit categories with findings**

Evidence:

- spec: Execution section - 'Each agent returns a report with findings in Critical / Important / Nit categories plus agent-specific sections'
- spec: Output format section - shows Critical, Important, Nits as top-level sections

**Claim: Code-reviewer agent includes Verification Story section**

Evidence:

- spec: Output format section - '### Verification Story (from code-reviewer)' lists Tests reviewed / build verified / security checked

**Claim: Test-engineer agent includes Coverage Gaps and Smoke Test Result sections**

Evidence:

- spec: Output format section - '### Coverage Gaps (from test-engineer)' with concrete untested behavior
- spec: Output format section - '### Smoke Test Result (from test-engineer)' with Commands run / suite pass-fail

**Claim: Comment-auditor agent includes detailed Comment Audit section with MUST KILL, Correctness, Kept, Skipped subsections**

Evidence:

- spec: Output format section - '### Comment Audit (from comment-auditor)' with MUST KILL / Correctness / Kept / Skipped breakdown

**Claim: Coordinator merge adds source attribution to all findings: [code-reviewer|test-engineer|comment-auditor|all]**

Evidence:

- spec: Synthesis section - 'Critical / Important / Nits: combined list with attributions'
- spec: Output format example - '- [code-reviewer|test-engineer|comment-auditor|all] file:line issue'

**Claim: Verdict determination: APPROVE if all pass + only nits; REQUEST CHANGES if any Critical/Important**

Evidence:

- spec: Synthesis section - 'Verdict: APPROVE (if all pass and only nits), REQUEST CHANGES (if any agent flags Critical or Important)'

**Claim: Coordinator output preserves specialist sections and adds Scope, Overview, and What's Done Well**

Evidence:

- spec: Output format section - shows Verdict, Scope, Overview, then merged Critical/Important/Nits, then specialist sections (Coverage Gaps, Smoke Test Result, Verification Story, Comment Audit), finally What's Done Well

### Probe: Git diff and scope detection patterns

**Claim: No existing git diff or scope detection patterns in codebase.**

Evidence:

- `agent/extensions/sdd/memory.ts:3` only detects .git directory existence, does not execute git commands
- `agent/extensions/protected-paths/index.ts` protects .git and node_modules but does not interact with git state
- `agent/extensions/sdd/workflows.ts` passes prompt strings and schema to agents; no git-specific scope descriptors defined

**Claim: Three-agent parallel orchestration pattern available in pi-dynamic-workflows but not yet used in extensions.**

Evidence:

- `agent/extensions/sdd/workflows.ts` shows `agent()` called for discovery agents but not `parallel()` or multi-agent orchestration
- DISCOVERY_SCRIPT, RESEARCH_SCRIPT, SINGLE_SCRIPT templates show serial probe execution, not parallel verification agents

### Probe: Test runner and test structure

**Claim: Test framework is Node.js built-in test module (`node:test`)**

Evidence:

- `tests/smoke.test.ts:8` imports `{ test } from "node:test"`
- `tests/sdd.test.ts:6` imports `{ test } from "node:test"`
- `tests/resources.test.ts:3` imports `{ test } from "node:test"`
- `mise.toml:19` defines test task as `run = "node --test tests/*.test.ts"`

**Claim: Assertions use Node.js strict assertion module (`node:assert/strict`)**

Evidence:

- `tests/smoke.test.ts:5` imports `import assert from "node:assert/strict"`
- `tests/sdd.test.ts:1` imports `import assert from "node:assert/strict"`
- `tests/resources.test.ts:1` imports `import assert from "node:assert/strict"`
- All test files consistently use `assert.equal()`, `assert.ok()`, `assert.deepEqual()` patterns

**Claim: Snapshots are stored as JSON files in `tests/snapshots/` and managed with `matchSnapshot()` helper**

Evidence:

- `tests/helpers.ts:27-38` defines `matchSnapshot()` which reads/writes to `tests/snapshots/{name}` path
- `tests/helpers.ts:31-36` shows snapshot comparison and `UPDATE_SNAPSHOTS` env variable support
- `tests/smoke.test.ts:29` calls `matchSnapshot("commands.json", ...)`
- `tests/resources.test.ts:22` calls `matchSnapshot("resources.json", ...)`
- `mise.toml:23-25` defines snapshot task with `UPDATE_SNAPSHOTS = "1"` env

**Claim: Test pattern uses `isolate()` helper to create isolated temporary environments**

Evidence:

- `tests/helpers.ts:5-15` defines `isolate()` creating temp dirs for HOME and cwd
- `tests/sdd.test.ts:33` uses `const tmp = () => mkdtempSync(join(tmpdir(), "sdd-"))` for temp storage
- `tests/smoke.test.ts:13` calls `const { cwd } = isolate()` to set up test environment
- `tests/resources.test.ts:5` calls `const { cwd } = isolate()` for isolated testing

**Claim: Path normalization in snapshots replaces absolute paths with `<CWD>` and `<REPO>` tokens**

Evidence:

- `tests/helpers.ts:20-22` defines `normalize()` function that replaces cwd and REPO paths
- `tests/smoke.test.ts:29` calls `normalize(JSON.stringify(...), cwd)` before snapshot comparison
- `tests/resources.test.ts:22` calls `normalize(JSON.stringify(...), cwd)` for reproducibility

**Claim: TypeScript configuration enforces strict mode and supports .ts test files**

Evidence:

- `tsconfig.json` includes tests/**/*.ts in compile targets
- `tsconfig.json:4` sets `"strict": true`
- `tsconfig.json:6` sets `"allowImportingTsExtensions": true` for importing .ts files directly
- `package.json` lists typescript 7.0.2 and @types/node 24.13.6 as devDependencies

**Claim: Tests run via `mise run test`, typecheck via `mise run typecheck`, snapshots regenerated with `mise run snapshot`**

Evidence:

- `mise.toml:15-18` defines typecheck task with `npx tsc --noEmit`
- `mise.toml:20-23` defines test task with `node --test tests/*.test.ts`
- `mise.toml:25-27` defines snapshot task that sets `UPDATE_SNAPSHOTS=1` and runs test task
- `tests/smoke.test.ts:11` asserts tests run via `mise run test`

### Probe: Prompt template structure in .pi/prompts/

**Claim: Prompt templates are markdown files with YAML frontmatter metadata and template variables**

Evidence:

- `agent/prompts/review.md`: YAML frontmatter with 'description' and 'argument-hint' keys, body with ${@:-default} syntax
- `/Users/mateczekus/.local/share/mise/installs/pi/0.87.0/pi/docs/prompt-templates.md:1-60`: Format section documents frontmatter keys and variable syntax

**Claim: Pi loads prompts from .pi/prompts/ (project), ~/.pi/agent/prompts/ (global), packages, and settings**

Evidence:

- `/Users/mateczekus/.local/share/mise/installs/pi/0.87.0/pi/docs/prompt-templates.md:20-27`: 'Locations' section lists all loading paths; project templates require trust

**Claim: Template variables support positional arguments, defaults, and slicing: $1, $@, ${1:-default}, ${@:N:L}**

Evidence:

- `/Users/mateczekus/.local/share/mise/installs/pi/0.87.0/pi/docs/prompt-templates.md:69-84`: 'Arguments' section documents all interpolation syntax with examples

**Claim: Pi exposes templates as slash commands: /name from filename, with description and argument-hint in autocomplete**

Evidence:

- `/Users/mateczekus/.local/share/mise/installs/pi/0.87.0/pi/docs/prompt-templates.md:47-65`: 'Argument Hints' section shows autocomplete rendering and usage examples
- `agent/prompts/review.md`: shows filename becomes command (/review) with description and argument-hint exposed

**Claim: Programmatically generated prompts in sdd use memory blocks (XML-like <research> tags) and helper functions (replaceSection, renderResearch) to compose multi-part prompts**

Evidence:

- `agent/extensions/sdd/prompts.ts:95-110`: planPrompt() function builds prompt with <spec>, <discovery>, <research>, and memory argument blocks; renderResearch() function formats findings
- `agent/extensions/sdd/prompts.ts:35-45`: replaceSection() and section() helpers manipulate markdown sections by heading

### Probe: Available dependencies for git, testing, and environment

**Claim: Project currently has no npm packages for git operations; uses direct git CLI via shell**

Evidence:

- `package.json:1-20` shows no git-related dependencies
- `mise.toml:28-30` shows drift task calling `git status --porcelain` directly

**Claim: Test running already uses Node.js built-in node:test module without additional test framework**

Evidence:

- `mise.toml:20-22` runs tests with `node --test tests/*.test.ts`
- `package.json:1-20` has no test runner dependency (Jest, Vitest, Mocha, etc.)

**Claim: Command execution capability already present via node:child_process**

Evidence:

- `tests/smoke.test.ts:3` imports execFileSync and spawn from node:child_process
- `tests/secrets.test.ts:2` imports spawnSync from node:child_process

**Claim: simple-git should be added for reliable git operations (diff, merge-base, file status)**

Evidence:

- Specification requires git diff computation for branch, commit-range, and file targets (spec: Scope establishment section)
- Current CLI approach fragile; library approach more reliable for parsing and error handling

**Claim: Test suite detection can use native fs + package.json scanning; no package needed**

Evidence:

- Specification assumes auto-detection via package.json scripts or Makefile (spec: Assumptions section)
- Node.js native fs module suffices for scanning; no external package required

### Probe: Extension command registration and routing

**Claim: Slash commands are registered using pi.registerCommand(name, config) API**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:227-238`: command() function wraps pi.registerCommand() with name, description, getArgumentCompletions?, and handler properties

**Claim: Command registration takes a config object with description, optional getArgumentCompletions, and handler function**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:230-232`: `pi.registerCommand(name, { description, getArgumentCompletions: phases ? (prefix) => featureCompletions(...) : undefined, handler: async (args, ctx) => {...} })`

**Claim: Command handlers receive (args: string, ctx: ExtensionCommandContext) where args is raw argument string**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:233`: `handler: async (args, ctx) => { ... }`
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:226`: `handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>`

**Claim: ExtensionCommandContext provides cwd, hasUI, ui (with notify/select/input/confirm), and modelRegistry properties**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:233-238`: `ctx.cwd = updated in handler; ctx.hasUI checked; ctx.ui.notify() called`
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:86`: `tierModel(ctx)` accesses `ctx.cwd` and `ctx.modelRegistry`

**Claim: ExtensionContext is the general extension registration context passed to the default export function**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:1`: `import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'`
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:105`: `export default function (pi: ExtensionAPI, options: SddOptions = {})` receives ExtensionAPI

**Claim: Argument parsing is the extension's responsibility; args arrive as whitespace-trimmed strings parsed by handler logic (e.g., args.trim(), splitArgs utility)**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:249`: `if (!args.trim()) return void ctx.ui.notify('Usage: /spec <what you want to change>', 'warning');`
- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:265`: `const { feature, rest } = splitArgs(args);` shows custom argument parsing

**Claim: Tools are registered separately with pi.registerTool(name, config) with parameters typed using Typebox, and execute(id, params, signal, onUpdate, ctx) handler**

Evidence:

- `/Users/mateczekus/Documents/throwaway/ultimate-harness/agent/extensions/sdd/index.ts:310-335`: `pi.registerTool({ name, description, promptSnippet, parameters: Type.Object(...), async execute(_id, params, _signal, _onUpdate, ctx) {...} })`

### Probe: Standard git and test suite APIs for Node.js

**Claim: simple-git is the standard library for programmatic git operations in Node.js, supporting diff, merge-base, and commit ranges**

Evidence:

- `https://www.npmjs.com/package/simple-git` - npm registry lists simple-git as widely-used git library
- `https://github.com/elastic/simple-git/blob/077e9785/readme.md` - Documents .diff(), .diffSummary(), .log(from/to), .merge(), .mergeFromTo() methods
- `https://github.com/steveukx/git-js/blob/main/simple-git/typings/simple-git.d.ts` - TypeScript typings confirm API

**Claim: Node.js built-in node:test module provides programmatic run() API for test execution since v18 (stable v20)**

Evidence:

- `https://nodejs.org/api/test.html` - Official Node.js test runner documentation showing run() function with options parameter for cwd, files, isolation, concurrency
- `https://beta.docs.nodejs.org/test/run` - Stable run() API documentation

**Claim: npm deprecated its programmatic API after v8.0; child_process shell execution is the standard fallback pattern**

Evidence:

- `https://stackoverflow.com/questions/72208532` - Explanation that npm 8.0+ dropped programmatic API support; recommends child_process approach
- `https://stackoverflow.com/questions/15957529` - Notes official deprecation and directs users to child_process
- `https://www.npmjs.com/package/npm-programmatic` - Legacy package documentation (still exists but npm-programmatic uses deprecated npm API)

**Claim: Detecting npm scripts requires no special library; parse package.json as plain JSON and access scripts property**

Evidence:

- `https://docs.npmjs.com/cli/v12/using-npm/scripts/` - npm Docs define scripts format as a standard JSON object
- `https://github.com/npm/read-package-json` - README shows this repo is archived and directs to use plain JSON parsing instead

### Probe: Scope descriptor schema for parallel agents

**Claim: Scope descriptor must contain changed files and commands to reproduce diff for all three agents to evaluate consistently**

Evidence:

- spec: 'Scope establishment: Resolve the target to a diff; build a scope descriptor listing changed files and commands to reproduce the diff'
- spec output: 'Scope: [files reviewed, commands to reproduce diff]'
- spec parallel execution: 'Launch all three agents concurrently with the identical scope descriptor'

**Claim: Scope descriptor structure should include: (1) changed files list, (2) diff content or per-file changes, (3) reproduction command/commit range, (4) metadata about verification target type**

Evidence:

- spec invocation patterns support four target types: current branch vs main, commit range (HEAD~3..HEAD), single file, branch vs main
- spec output includes 'commands to reproduce diff' suggesting commands are first-class in scope
- test-engineer agent needs 'runs suite and smoke tests' capability, requiring test command discovery
- each agent evaluates 'changes' implying they need change details beyond file names

**Claim: Scope descriptor should be JSON/object structure for consistent passing to three agents via parallel() orchestration**

Evidence:

- pi-dynamic-workflows pattern: parallel() takes array of thunks, each calling agent(prompt, {schema})
- example in classify-and-act.js passes JSON-stringified item to each agent in prompt
- all three agents need identical scope, requiring deterministic serializable format
- agent() receives prompt as string, so scope must be JSON-serializable and embedded in prompt or context

**Claim: Recommended scope descriptor schema: {targetType, targetValue, changedFiles: [{path, status, diff/content}], diffCommand, baseRef, headRef, testCommand?, smokeTestCommands?}**

Evidence:

- targetType resolves invocation ambiguity (branch|commitRange|filePath|implicit)
- changedFiles supports code-reviewer (file-level review) and comment-auditor (per-file comments)
- diff/content per file enables offline evaluation without git access in agent
- diffCommand and baseRef/headRef allow agents to verify or re-run scope if needed
- testCommand and smokeTestCommands support test-engineer's 'runs suite and smoke tests' requirement

## Pre-answered questions

From probes:

- What is the exact signature and behavior of parallel() in pi-dynamic-workflows? `parallel(thunks) => Promise<Array<unknown | null>>`, runs thunks concurrently, returns results in input order, recoverable failures become null.
- What parameters does agent() accept? prompt (string) + options: label, tier, schema, model, agentType, thread, isolation, keepWorktree, cwd, thinking, timeoutMs, retries.
- How do schemas shape agent responses? JSONSchema objects passed to agent(); noncompliance throws; returns text, validated value, or recoverable null.
- What is the model/tier routing priority? Explicit model > agentType model > tier > phase model > inherited main model > implicit medium > session default.
- How are slash commands registered? pi.registerCommand(name, {description, getArgumentCompletions?, handler}) API; args arrive as raw string to handler(args, ctx).
- What does ExtensionCommandContext provide? cwd, hasUI, ui (notify/select/input/confirm), modelRegistry.
- What test framework is used? Node.js built-in `node:test` module with `node:assert/strict`.
- How are snapshots handled? JSON files in tests/snapshots/ with matchSnapshot() helper; UPDATE_SNAPSHOTS env variable for regeneration.
- How are prompts templated? Markdown with YAML frontmatter (description, argument-hint); variables ${@:-default}, $1, ${@:N:L}; pi loads from .pi/prompts/ (project) and ~/.pi/agent/prompts/ (global).
- How should scope descriptor be structured? JSON object with targetType, changedFiles, diffCommand, baseRef/headRef, optional testCommand/smokeTestCommands for parallel agent consumption.

## Remaining gaps

From probes:

- Default concurrency limits or per-thunk timeout behavior in parallel().
- Thread isolation mechanics within parallel() batches.
- Exact error classification for 'recoverable' vs 'nonrecoverable' failures beyond limit/validation/budget.
- Memory or resource pooling constraints when parallel() spans many thunks.
- Exact TypeScript return type signature of agent<T>(prompt, options) -> Promise<T | string | null>.
- Full list of supported ModelThinkingLevel values.
- Complete JSONSchema constraint vocabulary supported by schemas (minItems, maxItems, enum, etc.).
- Real-world example of tier fallback cascade when tier unavailable in model-tiers config.
- TypeScript/JSON schema definitions for verification reports (only markdown structure in spec).
- Exact shape of finding objects (e.g., {severity, message, file, line, attribution}).
- How agents handle missing specialist data (e.g., no tests found).
- Merge algorithm for combining same findings from multiple agents (deduplication rules).
- Full ExtensionAPI interface definition beyond registerCommand and registerTool.
- Complete ExtensionCommandContext interface definition (imported from @earendil-works/pi-coding-agent).
- getArgumentCompletions return type and completion protocol details.
- Tool parameter validation and type coercion beyond Typebox Type.Object.
- Whether pi-dynamic-workflows has specific prompt loading conventions beyond standard pi template format.

From spec open questions:

- Scope detection fallback: If git merge-base or diff fails, default to whole repo diff or fail?
- Smoke test environment: When test suite requires setup (db init, env vars, docker), skip smoke tests or document requirements?
- Large diffs: Should scope limit diff size (>100 files or 10k LOC) to avoid overwhelming agents?
- Verdict granularity: Middle verdict like "REVIEW REQUIRED" or stick to binary APPROVE/REQUEST CHANGES?
- Agent tier selection: Should code-reviewer and test-engineer run at "medium" tier (e.g., opus) for thoroughness, or configurable?

Implementation gaps (not documented, must be built):

- No existing git diff or scope detection patterns; need git CLI wrapper or simple-git integration.
- No test suite auto-detection logic; need package.json script scanner + Makefile fallback.
- No scope descriptor builders; need to implement four target types (branch, commit-range, file, implicit).
- No multi-agent coordinator; need to orchestrate parallel execution and synthesize reports.
- No agent-specific prompt templates defined; need .pi/prompts/verification/{code-reviewer,test-engineer,comment-auditor}.md.
- No schema builders for verification reports; need JSON schema definitions for agent outputs and coordinator synthesis.

## Relevant files

**Core workflow infrastructure:**

- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/capability-details.md`
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/runtime.md`
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/lifecycle.md`
- `node_modules/@quintinshaw/pi-dynamic-workflows/skills/workflow-authoring/references/invariants` (SKILL.md)
- `agent/extensions/sdd/workflows.ts` (parallel() and agent() usage examples)

**Extension patterns:**

- `agent/extensions/sdd/index.ts` (command registration, ExtensionAPI, ExtensionCommandContext)
- `agent/extensions/sdd/prompts.ts` (prompt composition with memory blocks, helper functions)
- `agent/settings.json` (extension registration)

**Prompt templates:**

- `agent/prompts/review.md` (markdown template structure)
- `/Users/mateczekus/.local/share/mise/installs/pi/0.87.0/pi/docs/prompt-templates.md` (pi template format spec)

**Test infrastructure:**

- `tests/helpers.ts` (isolate(), matchSnapshot(), normalize() utilities)
- `tests/smoke.test.ts`, `tests/sdd.test.ts`, `tests/resources.test.ts` (test patterns)
- `tests/snapshots/` (snapshot storage)
- `mise.toml` (test, typecheck, snapshot tasks)
- `tsconfig.json` (strict mode, .ts imports)

**Configuration:**

- `package.json` (devDependencies, no git or test runner libraries currently)
- `.git/` (exists, available for git operations)

**Specification:**

- Spec provided inline in probe results (expected behavior, output format, constraints)
