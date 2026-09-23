import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentRegistry, parseWorkflowScript, runWorkflow } from "@quintinshaw/pi-dynamic-workflows";
import register from "../agent/extensions/verification/index.ts";
import { mergeFindings, renderSummary, verdict, type Reports } from "../agent/extensions/verification/report.ts";
import { formatScope, isLarge, resolveScope, type Scope } from "../agent/extensions/verification/scope.ts";
import { VERIFY_SCRIPT, verifyArgs } from "../agent/extensions/verification/workflow.ts";

const AGENT_DIR = join(import.meta.dirname, "..", "agent");

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "verify-"));
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
	const cwd = tmp();
	git(cwd, ["init", "-b", "main"]);
	git(cwd, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
	return cwd;
}

function commitFile(cwd: string, path: string, content: string, message: string) {
	const full = join(cwd, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
	git(cwd, ["add", path]);
	git(cwd, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message]);
}

// --- scope.ts ---

test("resolveScope throws on a non-git directory", () => {
	const cwd = tmp();
	assert.throws(() => resolveScope(cwd, undefined), /not a git repository/);
});

test("default scope is empty when there are no changes", () => {
	const cwd = initRepo();
	const scope = resolveScope(cwd, undefined);
	assert.equal(scope.kind, "default");
	assert.deepEqual(scope.files, []);
});

test("default scope combines committed, uncommitted and untracked changes vs main", () => {
	const cwd = initRepo();
	git(cwd, ["checkout", "-b", "feature"]);
	commitFile(cwd, "a.ts", "committed\n", "add a");
	writeFileSync(join(cwd, "a.ts"), "committed\nmore\n");
	writeFileSync(join(cwd, "untracked.ts"), "new\n");
	const scope = resolveScope(cwd, undefined);
	assert.equal(scope.kind, "default");
	assert.equal(scope.base, "main");
	assert.deepEqual(scope.files, ["a.ts", "untracked.ts"]);
	assert.ok(scope.commands.includes("git diff main...HEAD"));
});

test("range target diffs a specific commit range", () => {
	const cwd = initRepo();
	commitFile(cwd, "a.ts", "a\n", "add a");
	commitFile(cwd, "b.ts", "b\n", "add b");
	const scope = resolveScope(cwd, "HEAD~1..HEAD");
	assert.equal(scope.kind, "range");
	assert.deepEqual(scope.files, ["b.ts"]);
	assert.deepEqual(scope.commands, ["git diff HEAD~1..HEAD"]);
});

test("a branch ref diffs against the base branch", () => {
	const cwd = initRepo();
	git(cwd, ["checkout", "-b", "feature"]);
	commitFile(cwd, "a.ts", "a\n", "add a");
	git(cwd, ["checkout", "main"]);
	const scope = resolveScope(cwd, "feature");
	assert.equal(scope.kind, "ref");
	assert.deepEqual(scope.files, ["a.ts"]);
});

test("a changed path target diffs just that path", () => {
	const cwd = initRepo();
	commitFile(cwd, "a.ts", "a\n", "add a");
	writeFileSync(join(cwd, "a.ts"), "a\nchanged\n");
	const scope = resolveScope(cwd, "a.ts");
	assert.equal(scope.kind, "path");
	assert.deepEqual(scope.files, ["a.ts"]);
	assert.deepEqual(scope.wholeFiles, []);
});

test("an unchanged path target reports whole files to read", () => {
	const cwd = initRepo();
	commitFile(cwd, "a.ts", "a\n", "add a");
	const scope = resolveScope(cwd, "a.ts");
	assert.equal(scope.kind, "path");
	assert.deepEqual(scope.files, []);
	assert.deepEqual(scope.wholeFiles, ["a.ts"]);
});

test("falls back to the working tree when there is no main or master branch", () => {
	const cwd = tmp();
	git(cwd, ["init", "-b", "trunk"]);
	git(cwd, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
	writeFileSync(join(cwd, "a.ts"), "new\n");
	const scope = resolveScope(cwd, undefined);
	assert.equal(scope.kind, "fallback");
	assert.deepEqual(scope.files, ["a.ts"]);
	assert.ok(scope.notes.length > 0);
});

test("isLarge flags scopes over the file or line thresholds", () => {
	assert.equal(isLarge({ files: 5, insertions: 10, deletions: 10 }), false);
	assert.equal(isLarge({ files: 101, insertions: 0, deletions: 0 }), true);
	assert.equal(isLarge({ files: 1, insertions: 6000, deletions: 5000 }), true);
});

test("formatScope renders target, files and commands", () => {
	const scope: Scope = {
		target: "a.ts",
		kind: "path",
		files: ["a.ts"],
		wholeFiles: [],
		commands: ["git diff -- a.ts"],
		stats: { files: 1, insertions: 1, deletions: 0 },
		notes: [],
	};
	const text = formatScope(scope);
	assert.match(text, /Target: a\.ts/);
	assert.match(text, /a\.ts/);
	assert.match(text, /git diff -- a\.ts/);
});

// --- workflow.ts ---

test("verify workflow script parses", () => {
	assert.equal(parseWorkflowScript(VERIFY_SCRIPT).meta.name, "verify");
});

function baseScope(): Scope {
	return {
		target: "main",
		kind: "default",
		base: "main",
		files: ["a.ts"],
		wholeFiles: [],
		commands: ["git diff main...HEAD"],
		stats: { files: 1, insertions: 1, deletions: 0 },
		notes: [],
	};
}

test("verify runs exactly three agent calls with identical scope, tier medium and read-only agentTypes", async () => {
	const calls: { label?: string; tier?: string; readOnly?: boolean; prompt: string }[] = [];
	const scope = baseScope();
	const registry = loadAgentRegistry("", { projectDir: "/does/not/exist", userDir: join(AGENT_DIR, "agents"), legacyUserDir: "/does/not/exist" });
	const result = await runWorkflow(VERIFY_SCRIPT, {
		args: verifyArgs(scope),
		persistLogs: false,
		agentRegistry: registry,
		agent: {
			run: async (prompt, options: any = {}) => {
				const deny = options.disallowedToolNames ?? [];
				calls.push({ label: options.label, tier: options.tier, readOnly: deny.includes("edit") && deny.includes("write"), prompt });
				return null;
			},
		},
	});
	assert.equal(calls.length, 3);
	assert.deepEqual(
		calls.map((c) => c.label).sort(),
		["code-reviewer", "comment-auditor", "test-engineer"],
	);
	assert.ok(calls.every((c) => c.tier === "medium"));
	assert.ok(calls.every((c) => c.readOnly), "every agentType denies edit and write");
	const scopeText = formatScope(scope);
	assert.ok(calls.every((c) => c.prompt.includes(scopeText)));
	assert.equal(JSON.stringify(result.result), JSON.stringify({ codeReviewer: null, testEngineer: null, commentAuditor: null }));
});

// --- report.ts ---

function reports(overrides: Partial<Reports> = {}): Reports {
	return {
		codeReviewer: {
			verdict: "APPROVE",
			overview: "Looks fine.",
			findings: [],
			doneWell: ["Clear naming"],
			verificationStory: { testsReviewed: "yes", buildVerified: "yes", securityChecked: "yes" },
		},
		testEngineer: {
			verdict: "APPROVE",
			overview: "Coverage is fine.",
			findings: [],
			doneWell: ["Good test isolation"],
			coverageGaps: [],
			smokeTest: { commands: ["npm test"], suite: "passed", manual: "", blocked: [] },
		},
		commentAuditor: {
			verdict: "APPROVE",
			overview: "Comments are clean.",
			doneWell: [],
			mustKill: [],
			correctness: [],
			nits: [],
			kept: [],
			skipped: [],
		},
		...overrides,
	};
}

test("mergeFindings dedupes at file:line, keeps the higher severity, and attributes [all]", () => {
	const r = reports({
		codeReviewer: {
			...reports().codeReviewer!,
			findings: [{ severity: "nit", file: "a.ts", line: 10, issue: "naming", fix: "" }],
		},
		testEngineer: {
			...reports().testEngineer!,
			findings: [{ severity: "important", file: "a.ts", line: 10, issue: "no test", fix: "add a test" }],
		},
		commentAuditor: {
			...reports().commentAuditor!,
			mustKill: [{ file: "a.ts", line: 10, issue: "dead comment" }],
		},
	});
	const merged = mergeFindings(r);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].severity, "important");
	assert.equal(merged[0].file, "a.ts");
	assert.equal(merged[0].line, 10);
	assert.deepEqual(merged[0].agents.sort(), ["code-reviewer", "comment-auditor", "test-engineer"]);
});

test("comment-auditor categories map to severities", () => {
	const r = reports({
		commentAuditor: {
			...reports().commentAuditor!,
			correctness: [{ file: "a.ts", line: 1, issue: "unjustified ts-ignore" }],
			mustKill: [{ file: "b.ts", line: 2, issue: "narration" }],
			nits: [{ file: "c.ts", line: 3, issue: "could tighten" }],
		},
	});
	const merged = mergeFindings(r);
	const bySev = Object.fromEntries(merged.map((f) => [f.file, f.severity]));
	assert.equal(bySev["a.ts"], "critical");
	assert.equal(bySev["b.ts"], "important");
	assert.equal(bySev["c.ts"], "nit");
});

test("verdict is APPROVE only with no critical/important findings, every agent reporting and no agent requesting changes", () => {
	assert.equal(verdict(reports(), []), "APPROVE");
	assert.equal(
		verdict(reports(), [{ severity: "important", file: "a.ts", line: 1, issue: "x", fix: "", agents: ["code-reviewer"] }]),
		"REQUEST CHANGES",
	);
	assert.equal(verdict(reports(), [{ severity: "nit", file: "a.ts", line: 1, issue: "x", fix: "", agents: ["code-reviewer"] }]), "APPROVE");
	assert.equal(verdict(reports({ testEngineer: null }), []), "REQUEST CHANGES");
	assert.equal(verdict(reports({ codeReviewer: { ...reports().codeReviewer!, verdict: "REQUEST CHANGES" } }), []), "REQUEST CHANGES");
});

test("renderSummary contains every section in order with none for empty lists", () => {
	const md = renderSummary(baseScope(), reports());
	const headings = [
		"## Verification Summary",
		"**Verdict:**",
		"**Scope:**",
		"**Overview:**",
		"### Critical",
		"### Important",
		"### Nits",
		"### Coverage Gaps",
		"### Smoke Test Result",
		"### Verification Story",
		"### Comment Audit",
		"### What's Done Well",
	];
	let cursor = -1;
	for (const h of headings) {
		const idx = md.indexOf(h);
		assert.ok(idx > cursor, `expected "${h}" after previous heading`);
		cursor = idx;
	}
	assert.match(md, /### Critical\n- none/);
	assert.match(md, /### Important\n- none/);
});

test("renderSummary reports a missing agent by name", () => {
	const md = renderSummary(baseScope(), reports({ commentAuditor: null }));
	assert.match(md, /comment-auditor did not return a report/);
});

// --- agent definitions ---

test("all three agentTypes are registered, read-only, and use the expected thinking level", () => {
	const registry = loadAgentRegistry("", { projectDir: "/does/not/exist", userDir: join(AGENT_DIR, "agents"), legacyUserDir: "/does/not/exist" });
	const expected: Record<string, string> = { "code-reviewer": "low", "test-engineer": "low", "comment-auditor": "high" };
	for (const [name, thinking] of Object.entries(expected)) {
		const def = registry.get(name);
		assert.ok(def, `${name} should be registered`);
		assert.ok(def!.disallowedTools?.includes("edit"));
		assert.ok(def!.disallowedTools?.includes("write"));
		assert.equal(def!.thinking, thinking);
	}
});

// --- index.ts command ---

function fakePi() {
	const commands = new Map<string, any>();
	const entries: { type: string; data: any }[] = [];
	const messages: any[] = [];
	const renderers = new Map<string, any>();
	const pi = {
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		sendMessage: (message: any) => messages.push(message),
	};
	return { pi: pi as any, commands, entries, messages, renderers };
}

function fakeCtx(cwd: string) {
	const notes: { message: string; level: string }[] = [];
	return {
		notes,
		ctx: {
			cwd,
			mode: "rpc",
			hasUI: true,
			ui: {
				notify: (message: string, level = "info") => notes.push({ message, level }),
				setWidget: () => {},
			},
		} as any,
	};
}

test("/verify reports nothing to verify when the scope is empty", async () => {
	const { pi, commands } = fakePi();
	register(pi);
	const cwd = initRepo();
	const { ctx, notes } = fakeCtx(cwd);
	await commands.get("verify").handler("", ctx);
	assert.ok(notes.some((n) => /Nothing to verify/.test(n.message)));
});

test("/verify fails fast when an agentType is missing", async () => {
	const { pi, commands } = fakePi();
	register(pi);
	const cwd = initRepo();
	commitFile(cwd, "a.ts", "a\n", "add a");
	writeFileSync(join(cwd, "a.ts"), "a\nchanged\n");
	const { ctx, notes } = fakeCtx(cwd);
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(tmp(), "agent");
	try {
		await commands.get("verify").handler("", ctx);
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
	}
	assert.ok(notes.some((n) => n.level === "error" && /not registered/.test(n.message)));
});

function writeAgentDefs(scopeCwd: string, disallowedTools: Record<string, string[]> = {}) {
	mkdirSync(join(scopeCwd, "agent", "agents"), { recursive: true });
	for (const name of ["code-reviewer", "test-engineer", "comment-auditor"]) {
		const deny = disallowedTools[name] ?? ["edit", "write"];
		writeFileSync(join(scopeCwd, "agent", "agents", `${name}.md`), `---\nname: ${name}\ndisallowedTools: ${deny.join(", ")}\n---\nbody`);
	}
}

async function withAgentDir<T>(scopeCwd: string, fn: () => Promise<T>): Promise<T> {
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(scopeCwd, "agent");
	try {
		return await fn();
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
	}
}

test("/verify renders a doc entry with the exact verdict and sends a non-displayed message", async () => {
	const { pi, commands, entries, messages } = fakePi();
	let ran = false;
	const run = async () => {
		ran = true;
		return { result: reports() };
	};
	register(pi, { run: run as any });
	const scopeCwd = initRepo();
	commitFile(scopeCwd, "a.ts", "a\n", "add a");
	writeFileSync(join(scopeCwd, "a.ts"), "a\nchanged\n");
	writeAgentDefs(scopeCwd);
	await withAgentDir(scopeCwd, async () => {
		const { ctx } = fakeCtx(scopeCwd);
		await commands.get("verify").handler("", ctx);
	});
	assert.ok(ran, "the workflow runner should have been invoked");
	assert.equal(entries.length, 1);
	assert.match(entries[0].data.markdown, /## Verification Summary/);
	assert.equal(entries[0].data.status, "APPROVE");
	assert.equal(messages.length, 1);
	assert.equal(messages[0].display, false);
	assert.equal(messages[0].customType, "verify-report");
});

test("/verify's entry renderer always shows the full markdown, not gated on the collapsed/expanded toggle", async () => {
	const { pi, commands, entries, renderers } = fakePi();
	register(pi, { run: (async () => ({ result: reports() })) as any });
	const scopeCwd = initRepo();
	commitFile(scopeCwd, "a.ts", "a\n", "add a");
	writeFileSync(join(scopeCwd, "a.ts"), "a\nchanged\n");
	writeAgentDefs(scopeCwd);
	await withAgentDir(scopeCwd, async () => {
		const { ctx } = fakeCtx(scopeCwd);
		await commands.get("verify").handler("", ctx);
	});
	const renderer = renderers.get("verify-doc");
	assert.ok(renderer, "a renderer must be registered for the verify doc entry");
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const collapsed = renderer({ data: entries[0].data }, { expanded: false }, theme);
	const expanded = renderer({ data: entries[0].data }, { expanded: true }, theme);
	assert.ok(collapsed, "collapsed render must still return a component");
	assert.ok(expanded, "expanded render must return a component");
	const childCount = (c: any) => c.children?.length;
	assert.equal(childCount(collapsed), childCount(expanded), "the report body must not depend on the expanded flag");
	assert.ok(childCount(collapsed) >= 2, "the collapsed render must already include the markdown body, not just a header");
});

test("/verify uses REQUEST CHANGES as the doc status when a report is missing", async () => {
	const { pi, commands, entries } = fakePi();
	const run = async () => ({ result: reports({ commentAuditor: null }) });
	register(pi, { run: run as any });
	const scopeCwd = initRepo();
	commitFile(scopeCwd, "a.ts", "a\n", "add a");
	writeFileSync(join(scopeCwd, "a.ts"), "a\nchanged\n");
	writeAgentDefs(scopeCwd);
	await withAgentDir(scopeCwd, async () => {
		const { ctx } = fakeCtx(scopeCwd);
		await commands.get("verify").handler("", ctx);
	});
	assert.equal(entries[0].data.status, "REQUEST CHANGES");
});

test("/verify refuses to run when an agentType denies edit but not write", async () => {
	const { pi, commands } = fakePi();
	let ran = false;
	const run = async () => {
		ran = true;
		return { result: reports() };
	};
	register(pi, { run: run as any });
	const scopeCwd = initRepo();
	commitFile(scopeCwd, "a.ts", "a\n", "add a");
	writeFileSync(join(scopeCwd, "a.ts"), "a\nchanged\n");
	writeAgentDefs(scopeCwd, { "test-engineer": ["edit"] });
	await withAgentDir(scopeCwd, async () => {
		const { ctx, notes } = fakeCtx(scopeCwd);
		await commands.get("verify").handler("", ctx);
		assert.ok(notes.some((n) => n.level === "error" && /test-engineer/.test(n.message) && /write/.test(n.message)));
	});
	assert.equal(ran, false, "the workflow should never run when the guard fails");
});

test("/verify warns on a large scope but still runs", async () => {
	const { pi, commands } = fakePi();
	let ran = false;
	const run = async () => {
		ran = true;
		return { result: reports() };
	};
	register(pi, { run: run as any });
	const scopeCwd = initRepo();
	for (let i = 0; i < 101; i++) commitFile(scopeCwd, `f${i}.ts`, `content ${i}\n`, `add f${i}`);
	writeAgentDefs(scopeCwd);
	await withAgentDir(scopeCwd, async () => {
		const { ctx, notes } = fakeCtx(scopeCwd);
		await commands.get("verify").handler("HEAD~101..HEAD", ctx);
		assert.ok(notes.some((n) => n.level === "warning" && /Large scope/.test(n.message)));
	});
	assert.ok(ran, "a large scope should still run, not block");
});

test("/verify surfaces a scope resolution error instead of throwing", async () => {
	const { pi, commands } = fakePi();
	register(pi);
	const { ctx, notes } = fakeCtx(tmp());
	await commands.get("verify").handler("", ctx);
	assert.ok(notes.some((n) => n.level === "error" && /\/verify:/.test(n.message) && /not a git repository/.test(n.message)));
});
