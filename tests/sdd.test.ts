import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { parseWorkflowScript, runWorkflow } from "@quintinshaw/pi-dynamic-workflows";
import register from "../agent/extensions/sdd/index.ts";
import { memoryBlock, parseEntries } from "../agent/extensions/sdd/memory.ts";
import { renderResearch, validatePlan } from "../agent/extensions/sdd/prompts.ts";
import { SCOUT } from "../agent/extensions/sdd/runner.ts";
import {
	createFeature,
	featureCompletions,
	featureDir,
	listFeatures,
	nextResearchPath,
	readDoc,
	readState,
	setPhase,
	slugify,
	splitArgs,
	writeDoc,
} from "../agent/extensions/sdd/store.ts";
import {
	DISCOVERY_SCRIPT,
	discoveryArgs,
	ENRICH_SCRIPT,
	enrichArgs,
	MAX_PROBES,
	RESEARCH_SCRIPT,
	researchArgs,
	SINGLE_SCRIPT,
} from "../agent/extensions/sdd/workflows.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "sdd-"));

const VALID_PLAN = `# Plan: Phone

## Tasks
- [ ] 1. Add column

## Acceptance criteria
- Users can save a phone number

## Validation pipeline
- \`mise run test\` - unit tests
`;

test("slugify makes short kebab-case names", () => {
	assert.equal(slugify("Add a Phone Number field!"), "add-a-phone-number-field");
	assert.equal(slugify("***"), "feature");
	assert.ok(slugify("x".repeat(80)).length <= 48);
});

test("features get unique slugs, state and ordered listings", () => {
	const cwd = tmp();
	const a = createFeature(cwd, "phone-number-field", "Phone", new Date("2026-01-01T00:00:00Z"));
	const b = createFeature(cwd, "Phone Number Field", "Phone again", new Date("2026-01-02T00:00:00Z"));
	assert.equal(a.slug, "phone-number-field");
	assert.equal(b.slug, "phone-number-field-2");
	assert.ok(featureDir(cwd, a.slug).endsWith(join(".pi", "sdd", "phone-number-field")));
	setPhase(cwd, a.slug, "planned", new Date("2026-01-03T00:00:00Z"));
	assert.deepEqual(
		listFeatures(cwd).map((f) => [f.slug, f.phase]),
		[
			["phone-number-field", "planned"],
			["phone-number-field-2", "spec"],
		],
	);
	assert.deepEqual(
		featureCompletions(cwd, "phone", ["planned"])?.map((i) => i.value),
		["phone-number-field"],
	);
	assert.equal(featureCompletions(cwd, "zzz"), null);
	assert.throws(() => setPhase(cwd, "missing", "done"), /Unknown feature/);
});

test("research files are numbered from the highest existing one", () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "x", "X");
	assert.ok(nextResearchPath(cwd, slug).endsWith("research-1.md"));
	writeFileSync(join(featureDir(cwd, slug), "research-1.md"), "a");
	writeFileSync(join(featureDir(cwd, slug), "research-3.md"), "b");
	assert.ok(nextResearchPath(cwd, slug).endsWith("research-4.md"));
});

test("splitArgs separates the feature from the rest", () => {
	assert.deepEqual(splitArgs("  phone  validation rules "), { feature: "phone", rest: "validation rules" });
	assert.deepEqual(splitArgs("phone"), { feature: "phone", rest: "" });
});

test("memory reads hermes entries for the repo and the user", () => {
	assert.deepEqual(parseEntries("a <!-- created=1 -->\n§\n\n§\nb"), ["a", "b"]);
	const agentDir = tmp();
	const repo = join(tmp(), "proj");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "sub"));
	assert.equal(memoryBlock(repo, agentDir), "");
	mkdirSync(join(agentDir, "projects-memory", "proj"), { recursive: true });
	mkdirSync(join(agentDir, "pi-hermes-memory"));
	writeFileSync(join(agentDir, "projects-memory", "proj", "MEMORY.md"), "uses pnpm <!-- created=x -->");
	writeFileSync(join(agentDir, "pi-hermes-memory", "USER.md"), "likes Go");
	assert.equal(memoryBlock(join(repo, "sub"), agentDir), "<memory>\nProject memory:\n- uses pnpm\n\nUser profile:\n- likes Go\n</memory>");
});

test("validatePlan requires tasks, criteria and pipeline commands", () => {
	assert.deepEqual(validatePlan(VALID_PLAN), []);
	const errors = validatePlan("# Plan\n\n## Tasks\n- do it\n\n## Validation pipeline\nrun tests\n");
	assert.equal(errors.length, 3);
	assert.match(errors.join("\n"), /checkbox/);
	assert.match(errors.join("\n"), /Acceptance criteria/);
	assert.match(errors.join("\n"), /backticks/);
});

test("renderResearch writes the fixed format with deduplicated sources", () => {
	const md = renderResearch({
		question: "Phone validation",
		summary: "Use libphonenumber",
		findings: [
			{ claim: "E.164 is the standard", sources: ["https://a"] },
			{ claim: "Max 15 digits", sources: ["https://a", "https://b"] },
		],
		implications: ["Store E.164"],
		recommendation: "Normalize on write",
		openQuestions: [],
	});
	for (const heading of ["## Question", "## Summary", "## Findings", "## Implications for this feature", "## Recommendation", "## Open questions", "## Sources"]) {
		assert.ok(md.includes(heading), heading);
	}
	assert.equal(md.split("\n").filter((l) => l === "- https://a").length, 1);
	assert.match(md, /## Open questions\n\n- None/);
});

test("every workflow script parses", () => {
	for (const script of [SINGLE_SCRIPT, ENRICH_SCRIPT, DISCOVERY_SCRIPT, RESEARCH_SCRIPT]) {
		assert.ok(parseWorkflowScript(script).meta.name.startsWith("sdd_"));
	}
});

type Call = { prompt: string; label?: string; scout: boolean; tier?: string };

async function runStub(script: string, args: unknown, reply: (call: Call) => unknown) {
	const calls: Call[] = [];
	const result = await runWorkflow(script, {
		args,
		persistLogs: false,
		agentRegistry: new Map([[SCOUT.name, SCOUT]]),
		agent: {
			run: async (prompt, options: any = {}) => {
				const call = { prompt, label: options.label, scout: !!options.disallowedToolNames?.includes("write"), tier: options.tier };
				calls.push(call);
				return reply(call);
			},
		},
	});
	return { calls, result: result.result as any };
}

test("discovery caps probes at 10 and feeds every result to the synthesizer", async () => {
	const probes = Array.from({ length: 15 }, (_, i) => ({ kind: i === 0 ? "web" : "code", title: `p${i}`, question: `q${i}`, hints: "" }));
	const { calls, result } = await runStub(DISCOVERY_SCRIPT, discoveryArgs("SPEC", undefined, ""), (call) => {
		if (call.label === "plan probes") return { probes };
		if (call.label === "synthesize") return { markdown: "# Discovery" };
		return { findings: [{ claim: call.label, evidence: ["a.ts:1"] }], answered: [], gaps: [] };
	});
	const probeCalls = calls.filter((c) => c.label?.startsWith("probe "));
	assert.equal(probeCalls.length, MAX_PROBES);
	assert.ok(probeCalls.every((c) => c.scout && c.tier === "small"), "probes run as the read-only scout on the small tier");
	assert.match(probeCalls[0].prompt, /web_enable/, "web probes get web tool instructions");
	assert.doesNotMatch(probeCalls[1].prompt, /web_enable/);
	const synth = calls.find((c) => c.label === "synthesize");
	assert.match(synth?.prompt ?? "", /"title": "p9"/);
	assert.doesNotMatch(synth?.prompt ?? "", /"title": "p10"/);
	assert.equal(result.markdown, "# Discovery");
});

test("discovery falls back to one code probe when planning returns none", async () => {
	const { calls } = await runStub(DISCOVERY_SCRIPT, discoveryArgs("SPEC", "OLD", ""), (call) =>
		call.label === "synthesize" ? { markdown: "m" } : call.label === "plan probes" ? null : { findings: [], answered: [], gaps: [] },
	);
	assert.deepEqual(
		calls.map((c) => c.label),
		["plan probes", "probe 1: related code", "synthesize"],
	);
	assert.match(calls[2].prompt, /<existing-discovery>\nOLD/);
});

test("enrich runs scope, repo scout and questions in parallel", async () => {
	const { calls, result } = await runStub(ENRICH_SCRIPT, enrichArgs("add phone", "<memory>m</memory>"), (call) => ({ label: call.label }));
	assert.deepEqual(calls.map((c) => c.label).sort(), ["open questions", "repo context", "scope"]);
	assert.deepEqual(
		calls.filter((c) => c.scout).map((c) => c.label),
		["repo context"],
	);
	assert.match(calls.find((c) => c.label === "scope")?.prompt ?? "", /<memory>m<\/memory>/);
	assert.deepEqual(result.scope, { label: "scope" });
});

test("research gathers per query and reports from supported claims", async () => {
	const { calls, result } = await runStub(RESEARCH_SCRIPT, researchArgs("phone validation", "SPEC", undefined), (call) => {
		if (call.label === "plan queries") return { queries: ["a", "b", "c", "d", "e"] };
		if (call.label?.startsWith("research")) return { sources: [{ url: `https://${call.label}`, claims: ["c"] }] };
		if (call.label === "cross-check") return { supported: [{ claim: "c", sources: ["https://x"] }] };
		return { summary: "s", findings: [], implications: [], recommendation: "r", openQuestions: [] };
	});
	assert.equal(calls.filter((c) => c.label?.startsWith("research")).length, 4);
	assert.match(calls.find((c) => c.label === "cross-check")?.prompt ?? "", /https:\/\/research 4/);
	assert.match(calls.find((c) => c.label === "write report")?.prompt ?? "", /"claim":"c"/);
	assert.equal(result.recommendation, "r");
});

function fakePi() {
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const entries: { type: string; data: any }[] = [];
	let active = ["read", "sdd_save_plan", "sdd_complete"];
	const pi = {
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (event: string, fn: any) => handlers.set(event, fn),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		setSessionName: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	return { pi: pi as any, commands, tools, handlers, entries, active: () => active };
}

function fakeCtx(cwd: string, selects: string[] = [], inputs: string[] = []) {
	const notes: string[] = [];
	return {
		notes,
		ctx: {
			cwd,
			mode: "rpc",
			hasUI: true,
			model: undefined,
			modelRegistry: { getAll: () => [], find: () => undefined },
			sessionManager: { getEntries: () => [] },
			ui: {
				select: async () => selects.shift(),
				input: async () => inputs.shift(),
				notify: (msg: string) => notes.push(msg),
				setWidget: () => {},
			},
		} as any,
	};
}

test("registers the SDD commands and session tools", () => {
	const { pi, commands, tools, handlers } = fakePi();
	register(pi);
	assert.deepEqual([...commands.keys()].sort(), ["discover", "implement", "plan", "research", "sdd", "spec"]);
	assert.deepEqual([...tools.keys()].sort(), ["sdd_complete", "sdd_save_plan"]);
	assert.ok(handlers.has("session_start"));
});

test("session tools stay off outside plan and implement sessions", async () => {
	const { pi, handlers, active } = fakePi();
	register(pi);
	const { ctx } = fakeCtx(tmp());
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	assert.deepEqual(active(), ["read"]);
	ctx.sessionManager.getEntries = () => [{ type: "custom", customType: "sdd-session", data: { kind: "plan", slug: "x" } }];
	await handlers.get("session_start")({ reason: "resume" }, ctx);
	assert.deepEqual(active(), ["read", "sdd_save_plan"]);
});

test("sdd_save_plan rejects invalid plans, relays feedback and saves on accept", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	const { pi, tools, entries } = fakePi();
	register(pi);
	const save = (markdown: string, ctx: any) => tools.get("sdd_save_plan").execute("id", { feature: slug, markdown, decisions: ["Store E.164"] }, undefined, undefined, ctx);

	const rejected = await save("# Plan\n", fakeCtx(cwd).ctx);
	assert.match(rejected.content[0].text, /Plan rejected/);

	const revised = await save(VALID_PLAN, fakeCtx(cwd, ["Suggest changes"], ["add a migration test"]).ctx);
	assert.match(revised.content[0].text, /add a migration test/);
	assert.equal(readDoc(cwd, slug, "plan.md"), undefined);

	const saved = await save(VALID_PLAN, fakeCtx(cwd, ["Accept"]).ctx);
	assert.match(saved.content[0].text, /memory_add with target "project"[\s\S]*Store E.164[\s\S]*\/implement phone/);
	assert.equal(readDoc(cwd, slug, "plan.md"), VALID_PLAN);
	assert.equal(readState(cwd, slug)?.phase, "planned");
	assert.deepEqual(
		entries.map((e) => e.data.status),
		["changes requested", "accepted"],
	);
});

test("sdd_complete appends results and closes the feature only when all pass", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	writeDoc(cwd, slug, "plan.md", VALID_PLAN);
	const { pi, tools } = fakePi();
	register(pi);
	const complete = (status: string) =>
		tools
			.get("sdd_complete")
			.execute("id", { feature: slug, results: [{ criterion: "saves phone", status, evidence: "tests pass" }] }, undefined, undefined, fakeCtx(cwd).ctx);
	assert.match((await complete("fail")).content[0].text, /1 criteria failed/);
	assert.equal(readState(cwd, slug)?.phase, "implementing");
	await complete("pass");
	assert.equal(readState(cwd, slug)?.phase, "done");
	assert.match(readDoc(cwd, slug, "plan.md") ?? "", /## Results\n\n- \[x\] saves phone: pass - tests pass\n$/);
});

test("/spec interviews, reviews, saves the spec, runs discovery and stops at the gate", async () => {
	const cwd = tmp();
	const labels: string[] = [];
	const run = async (_script: string, options: any) => {
		const args = options.args;
		if (args.scope) {
			labels.push("enrich");
			return { result: { scope: {}, repo: {}, questions: { questions: [{ id: "fmt", header: "Format", question: "Which format?", options: [{ label: "E.164" }, { label: "Free text" }] }] } } } as any;
		}
		if (args.label) {
			labels.push(args.label);
			assert.match(args.prompt, /Format: E.164/);
			const revise = args.label === "revise spec";
			if (revise) assert.match(args.prompt, /<feedback>\nmention limits/);
			return { result: { slug: revise ? "ignored" : "phone-number-field", title: "Phone number", markdown: revise ? "# Phone v2" : "# Phone" } } as any;
		}
		labels.push("discovery");
		return { result: { markdown: "# Discovery" } } as any;
	};
	const { pi, commands, entries } = fakePi();
	register(pi, { run });
	const { ctx, notes } = fakeCtx(cwd, ["E.164", "Suggest changes", "Accept", "Stop"], ["mention limits"]);
	await commands.get("spec").handler("add a phone number field to users", ctx);

	assert.deepEqual(labels, ["enrich", "draft spec", "revise spec", "discovery"]);
	assert.equal(readDoc(cwd, "phone-number-field", "spec.md"), "# Phone v2\n");
	assert.equal(readDoc(cwd, "phone-number-field", "discovery.md"), "# Discovery\n");
	assert.equal(readState(cwd, "phone-number-field")?.phase, "discovered");
	assert.deepEqual(
		entries.map((e) => `${e.data.title} (${e.data.status})`),
		["Spec: Phone number (changes requested)", "Spec: Phone number (accepted)", "Discovery: phone-number-field (saved)"],
	);
	assert.ok(notes.some((n) => n.includes("/plan phone-number-field")), notes.join("\n"));
});

test("/implement refuses a feature without a plan", async () => {
	const cwd = tmp();
	createFeature(cwd, "phone", "Phone");
	const { pi, commands } = fakePi();
	register(pi);
	const { ctx, notes } = fakeCtx(cwd);
	await commands.get("implement").handler("phone", ctx);
	assert.match(notes[0], /has no plan\.md/);
	assert.ok(!existsSync(join(featureDir(cwd, "phone"), "plan.md")));
});

test("/plan hands off to a fresh session seeded with spec, discovery and research", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	writeDoc(cwd, slug, "spec.md", "SPEC BODY");
	writeDoc(cwd, slug, "discovery.md", "DISCOVERY BODY");
	writeFileSync(join(featureDir(cwd, slug), "research-1.md"), "RESEARCH BODY");
	const { pi, commands } = fakePi();
	register(pi);
	const { ctx } = fakeCtx(cwd);
	let sent = "";
	ctx.newSession = async ({ withSession }: any) => {
		await withSession({ sendUserMessage: async (text: string) => (sent = text) });
		return { cancelled: false };
	};
	await commands.get("plan").handler("", ctx);
	for (const part of ["SPEC BODY", "DISCOVERY BODY", "RESEARCH BODY", "ask_user", 'sdd_save_plan with feature "phone"', "## Acceptance criteria"]) {
		assert.ok(sent.includes(part), part);
	}
	assert.equal(readFileSync(join(featureDir(cwd, slug), "state.json"), "utf8").includes('"phase": "spec"'), true);
});

test("feature names that are not slugs never reach the filesystem", async () => {
	const cwd = tmp();
	assert.throws(() => featureDir(cwd, "../x"), /Invalid feature name/);
	mkdirSync(join(cwd, ".pi", "x"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "x", "plan.md"), VALID_PLAN);
	const { pi, tools } = fakePi();
	register(pi);
	const result = await tools
		.get("sdd_complete")
		.execute("id", { feature: "../x", results: [{ criterion: "c", status: "pass", evidence: "e" }] }, undefined, undefined, fakeCtx(cwd).ctx);
	assert.match(result.content[0].text, /Unknown feature/);
	assert.equal(readFileSync(join(cwd, ".pi", "x", "plan.md"), "utf8"), VALID_PLAN);
	const saved = await tools.get("sdd_save_plan").execute("id", { feature: "../x", markdown: VALID_PLAN, decisions: [] }, undefined, undefined, fakeCtx(cwd).ctx);
	assert.match(saved.content[0].text, /Unknown feature/);
});

test("sdd_complete replaces earlier results instead of stacking them", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	writeDoc(cwd, slug, "plan.md", VALID_PLAN);
	const { pi, tools } = fakePi();
	register(pi);
	const complete = (status: string) =>
		tools.get("sdd_complete").execute("id", { feature: slug, results: [{ criterion: "c", status, evidence: "e" }] }, undefined, undefined, fakeCtx(cwd).ctx);
	await complete("fail");
	assert.equal(readState(cwd, slug)?.phase, "implementing");
	await complete("pass");
	const plan = readDoc(cwd, slug, "plan.md") ?? "";
	assert.equal(plan.split("## Results").length, 2);
	assert.match(plan, /- \[x\] c: pass - e\n$/);
	assert.ok(plan.startsWith(VALID_PLAN.trimEnd()));
});

test("toQuestions assigns ids that cannot collide", async () => {
	const { toQuestions } = await import("../agent/extensions/sdd/index.ts");
	const opts = [{ label: "a" }, { label: "b" }];
	const qs = toQuestions({
		questions: [
			{ id: "q2", header: "A very long header", question: "A?", options: opts },
			{ id: "x", header: "B", question: "B?", options: [{ label: "only" }] },
			{ id: "q2", header: "C", question: "C?", options: opts, multiSelect: true },
		],
	});
	assert.deepEqual(
		qs.map((q) => [q.id, q.header, q.multiSelect]),
		[
			["q1", "A very long header", false],
			["q2", "C", true],
		],
	);
	const schema: any = enrichArgs("r", "").questions.schema;
	assert.ok(schema.properties.questions.items.required.includes("multiSelect"));
});

function withSessions(ctx: any, handlers: Map<string, any>) {
	let sent = "";
	ctx.newSession = async ({ withSession }: any) => {
		await handlers.get("session_start")({ reason: "new" }, ctx);
		await withSession({ sendUserMessage: async (text: string) => (sent = text) });
		return { cancelled: false };
	};
	ctx.ui.confirm = async () => false;
	return () => sent;
}

test("/implement marks the feature implementing only once the new session starts", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	writeDoc(cwd, slug, "plan.md", VALID_PLAN);
	const { pi, commands, handlers, entries, active } = fakePi();
	register(pi);
	const { ctx } = fakeCtx(cwd);
	const sent = withSessions(ctx, handlers);
	await commands.get("implement").handler(slug, ctx);
	assert.equal(readState(cwd, slug)?.phase, "implementing");
	assert.match(sent(), /sdd_complete with feature "phone"/);
	assert.deepEqual(active(), ["read", "sdd_complete"]);
	assert.deepEqual(entries.at(-1), { type: "sdd-session", data: { kind: "implement", slug } });

	setPhase(cwd, slug, "done");
	let started = false;
	ctx.newSession = async () => {
		started = true;
		return { cancelled: false };
	};
	await commands.get("implement").handler(slug, ctx);
	assert.equal(started, false, "a done feature needs confirmation");
});

test("a failed session switch does not leak the handoff into the next session", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	writeDoc(cwd, slug, "spec.md", "SPEC");
	const { pi, commands, handlers, entries } = fakePi();
	register(pi);
	const { ctx, notes } = fakeCtx(cwd);
	ctx.newSession = async () => {
		throw new Error("boom");
	};
	await commands.get("plan").handler(slug, ctx);
	assert.ok(notes.some((n) => n.includes("/plan: boom")));
	await handlers.get("session_start")({ reason: "new" }, ctx);
	assert.equal(entries.filter((e) => e.type === "sdd-session").length, 0);
});

test("commands refuse to run without UI and report handler errors", async () => {
	const cwd = tmp();
	const { slug } = createFeature(cwd, "phone", "Phone");
	writeDoc(cwd, slug, "spec.md", "SPEC");
	const { pi, commands } = fakePi();
	register(pi, { run: async () => ({ result: { markdown: "" } }) as any });
	const headless = fakeCtx(cwd);
	headless.ctx.hasUI = false;
	await commands.get("sdd").handler("", headless.ctx);
	assert.match(headless.notes[0], /needs the interactive UI/);
	const { ctx, notes } = fakeCtx(cwd);
	await commands.get("discover").handler(slug, ctx);
	assert.match(notes[0], /\/discover: Discovery returned no report/);
	await commands.get("plan").handler("nope", ctx);
	assert.match(notes[1], /Unknown feature "nope"/);
});

test("runSdd stops on Escape, rejects empty results and clears its widget", async () => {
	const { runSdd } = await import("../agent/extensions/sdd/runner.ts");
	const widgets: unknown[] = [];
	let onInput: ((data: string) => unknown) | undefined;
	const ctx: any = {
		cwd: tmp(),
		mode: "tui",
		hasUI: true,
		model: { provider: "p", id: "m" },
		ui: {
			setWidget: (_k: string, v: unknown) => widgets.push(v),
			onTerminalInput: (fn: any) => {
				onInput = fn;
				return () => (onInput = undefined);
			},
		},
	};
	let seen: any;
	const escaped = runSdd(ctx, "script", {}, {
		label: "demo",
		maxAgents: 1,
		run: async (_s, options) => {
			seen = options;
			options.onAgentStart?.({ id: "1", label: "agent one" } as any);
			assert.deepEqual(onInput?.("\u001b"), { consume: true });
			return { result: {} } as any;
		},
	});
	await assert.rejects(escaped, /demo was stopped/);
	assert.equal(seen.mainModel, "p/m");
	assert.deepEqual(seen.providerMiddlewareExtensions, ["pi-web-access"]);
	assert.ok(seen.agentRegistry.has("sdd-scout"));
	assert.equal(onInput, undefined, "escape listener removed");
	assert.equal(widgets.at(-1), undefined, "widget cleared");
	const widget = (widgets[0] as any)({ requestRender: () => {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t });
	assert.ok(widget.render(60).some((l: string) => l.includes("agent one")));
	widget.dispose();
	await assert.rejects(runSdd(ctx, "s", {}, { label: "empty", maxAgents: 1, run: async () => ({ result: null }) as any }), /empty returned no result/);
});

test("plan sections ignore headings inside code fences", () => {
	const plan = VALID_PLAN.replace("- `mise run test` - unit tests", "```bash\n# run everything\nmise run test\n```\n- `mise run test` - unit tests");
	assert.deepEqual(validatePlan(plan), []);
	assert.deepEqual(validatePlan(VALID_PLAN.replace("## Tasks", "## tasks")), []);
});

test("progress widget draws a bordered box with a spinner, recent results and stats", async () => {
	const { renderProgress, formatTokens } = await import("../agent/extensions/sdd/progress.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const paint = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
	const running = new Map(Array.from({ length: 12 }, (_, i) => [`r${i}`, `probe ${i + 1}: ${"long title ".repeat(6)}`] as [string, string]));
	const state = { label: "discovery", phase: "Probe", running, finished: [{ label: "probe 0: ok", failed: false }, { label: "probe x", failed: true }], done: 1, failed: 1, tokens: 632284 };
	const lines = renderProgress(state, paint, 50, 3);
	assert.ok(lines.every((l) => visibleWidth(l) === 50), lines.join("\n"));
	assert.match(lines[0], /^╭─ discovery · Probe ─+╮$/);
	assert.match(stripAnsi(lines.at(-1) ?? ""), /^╰─ 1 done · 1 failed · 12 running · 632k tokens …╯$/, "footer is cut to fit");
	assert.match(renderProgress(state, paint, 80, 0).at(-1) ?? "", /^╰─ 1 done · 1 failed · 12 running · 632k tokens · esc to stop ─+╯$/);
	assert.match(lines[1], /│ ✓ probe 0: ok/);
	assert.match(lines[2], /│ ✗ probe x/);
	assert.match(lines[3], /│ ⠸ probe 1: long title/);
	assert.equal(lines.length, 10, "8 rows plus 2 borders");
	assert.match(lines[8], /\+7 more running/);
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(1_250_000), "1.3M");
	const empty = renderProgress({ ...state, running: new Map(), finished: [], done: 0, failed: 0, tokens: 0 }, paint, 30, 0);
	assert.match(empty[1], /⠋ starting/);
});

test("formatTokens rounds across unit boundaries", async () => {
	const { formatTokens } = await import("../agent/extensions/sdd/progress.ts");
	assert.deepEqual([999, 1_000, 999_499, 999_600, 1_000_000].map(formatTokens), ["999", "1k", "999k", "1.0M", "1.0M"]);
});

test("progress widget without the TUI pushes plain bordered lines", async () => {
	const { progressWidget } = await import("../agent/extensions/sdd/progress.ts");
	const widgets: unknown[] = [];
	const ctx: any = { mode: "rpc", hasUI: true, ui: { setWidget: (_k: string, v: unknown) => widgets.push(v) } };
	const view = progressWidget(ctx, "discovery");
	assert.match((widgets[0] as string[])[1], /starting/);
	view.options.onAgentStart({ id: "1", label: "probe 1" });
	view.options.onAgentEnd({ id: "1", label: "probe 1", tokens: 1500 });
	const last = widgets.at(-1) as string[];
	assert.ok(last.every((l) => l.length === 80));
	assert.match(last.join("\n"), /✓ probe 1[\s\S]*1 done · 0 running · 2k tokens/);
	view.clear();
	assert.equal(widgets.at(-1), undefined);
});

test("progress widget spinner redraws on a timer and stops on dispose", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { progressWidget } = await import("../agent/extensions/sdd/progress.ts");
	let factory: any;
	const ctx: any = { mode: "tui", hasUI: true, ui: { setWidget: (_k: string, v: unknown) => (factory = v) } };
	const view = progressWidget(ctx, "discovery");
	let renders = 0;
	const widget = factory({ requestRender: () => renders++ }, { fg: (_c: string, s: string) => s, bold: (s: string) => s });
	const first = widget.render(40)[1];
	t.mock.timers.tick(80);
	assert.equal(renders, 1);
	assert.notEqual(widget.render(40)[1], first, "spinner frame advanced");
	view.options.onAgentStart({ id: "1", label: "probe 1" });
	assert.equal(renders, 2, "events redraw immediately");
	widget.dispose();
	t.mock.timers.tick(800);
	assert.equal(renders, 2, "no redraws after dispose");
});
