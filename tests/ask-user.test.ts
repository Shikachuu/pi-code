import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import register from "../agent/extensions/ask-user/index.ts";
import {
	type Action,
	createInterview,
	formatAnswers,
	initialState,
	layoutTabs,
	type Question,
	reduce,
	type State,
	validateQuestions,
} from "../agent/extensions/ask-user/interview.ts";
import { reviewDocument, reviewQuestion, toReviewResult } from "../agent/extensions/ask-user/review.ts";

const pick = (id: string, header: string, multiSelect = false): Question => ({
	id,
	header,
	question: `${header}?`,
	options: [{ label: "A" }, { label: "B" }],
	multiSelect,
});

function run(questions: Question[], actions: Action[]): State {
	return actions.reduce(reduce, initialState(questions));
}

test("registers only ask_user and the doc entry renderer", () => {
	const tools: string[] = [];
	const renderers: string[] = [];
	register({
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerEntryRenderer: (type: string) => renderers.push(type),
	} as any);
	assert.deepEqual(tools, ["ask_user"]);
	assert.deepEqual(renderers, ["ask-doc"]);
});

test("a single plain question submits on select", () => {
	const state = run([pick("a", "A")], [{ type: "down" }, { type: "select" }]);
	assert.equal(state.outcome, "submit");
	assert.deepEqual(state.answers.a, { selected: ["B"] });
});

test("tab cycles through questions and the submit tab with wraparound", () => {
	const qs = [pick("a", "A"), pick("b", "B")];
	assert.equal(run(qs, [{ type: "next" }]).tab, 1);
	assert.equal(run(qs, [{ type: "next" }, { type: "next" }]).tab, 2);
	assert.equal(run(qs, [{ type: "next" }, { type: "next" }, { type: "next" }]).tab, 0);
	assert.equal(run(qs, [{ type: "prev" }]).tab, 2);
});

test("select advances to the next tab and submit waits for every answer", () => {
	const qs = [pick("a", "A"), pick("b", "B")];
	let state = run(qs, [{ type: "select" }]);
	assert.equal(state.tab, 1);
	state = run(qs, [{ type: "select" }, { type: "next" }, { type: "select" }]);
	assert.equal(state.tab, 2);
	assert.equal(state.outcome, undefined, "b is unanswered");
	state = run(qs, [{ type: "select" }, { type: "select" }, { type: "select" }]);
	assert.equal(state.outcome, "submit");
	assert.deepEqual(state.answers, { a: { selected: ["A"] }, b: { selected: ["A"] } });
});

test("multiselect toggles options and needs the submit tab", () => {
	const qs = [pick("m", "M", true)];
	let state = run(qs, [{ type: "select" }, { type: "down" }, { type: "toggle" }]);
	assert.deepEqual(state.answers.m.selected, ["A", "B"]);
	state = reduce(state, { type: "toggle" });
	assert.deepEqual(state.answers.m.selected, ["A"]);
	assert.equal(state.outcome, undefined);
	state = run(qs, [{ type: "select" }, { type: "next" }, { type: "select" }]);
	assert.equal(state.outcome, "submit");
});

test("the free-form row opens the editor and its text replaces a single choice", () => {
	const qs = [pick("a", "A"), pick("b", "B")];
	let state = run(qs, [{ type: "select" }, { type: "prev" }, { type: "down" }, { type: "down" }, { type: "select" }]);
	assert.equal(state.editing, true);
	assert.equal(reduce(state, { type: "next" }).tab, state.tab, "tab keys go to the editor");
	state = reduce(state, { type: "freeform", text: "  my own  " });
	assert.equal(state.editing, false);
	assert.deepEqual(state.answers.a, { selected: [], freeform: "my own" });
	assert.equal(state.tab, 1);
});

test("empty free-form text leaves the question unanswered", () => {
	const state = run([pick("a", "A")], [{ type: "down" }, { type: "down" }, { type: "select" }, { type: "freeform", text: " " }]);
	assert.equal(state.outcome, undefined);
	assert.deepEqual(state.answers.a, { selected: [], freeform: undefined });
});

test("escape leaves the editor first, then cancels", () => {
	const qs = [pick("a", "A")];
	let state = run(qs, [{ type: "down" }, { type: "down" }, { type: "select" }, { type: "cancel" }]);
	assert.equal(state.editing, false);
	assert.equal(state.outcome, undefined);
	state = reduce(state, { type: "cancel" });
	assert.equal(state.outcome, "cancel");
	assert.equal(reduce(state, { type: "select" }), state, "finished state ignores input");
});

test("validateQuestions rejects empty lists, duplicate ids and single options", () => {
	assert.match(validateQuestions([]) ?? "", /No questions/);
	assert.match(validateQuestions([pick("a", "A"), pick("a", "B")]) ?? "", /Duplicate/);
	assert.match(validateQuestions([{ ...pick("a", "A"), options: [{ label: "x" }] }]) ?? "", /at least 2/);
	assert.equal(validateQuestions([pick("a", "A")]), undefined);
	assert.match(validateQuestions([{ ...pick("a", "A"), options: [{ label: "x" }, { label: "x" }] }]) ?? "", /duplicate option labels/);
	assert.match(validateQuestions([{ ...pick("a", "A"), options: [{ label: "x" }, { label: "Done" }] }]) ?? "", /reserved option label "Done"/);
	assert.match(validateQuestions([{ ...pick("a", "A"), options: [{ label: "x" }, { label: "Type something." }] }]) ?? "", /reserved/);
});

test("formatAnswers lists choices and free text by header", () => {
	const qs = [pick("a", "Auth"), pick("b", "Store")];
	assert.equal(
		formatAnswers(qs, { a: { selected: ["A"] }, b: { selected: [], freeform: "sqlite" } }),
		"Auth: A\nStore: user wrote: sqlite",
	);
});

test("review answers map to accept, revise and cancel", () => {
	const q = reviewQuestion("Spec");
	assert.equal(q.otherLabel, "Suggest changes");
	assert.deepEqual(toReviewResult({ review: { selected: ["Accept"] } }), { action: "accept" });
	assert.deepEqual(toReviewResult({ review: { selected: [], freeform: "add limits" } }), { action: "revise", feedback: "add limits" });
	assert.deepEqual(toReviewResult({ review: { selected: ["Cancel"] } }), { action: "cancel" });
	assert.deepEqual(toReviewResult(undefined), { action: "cancel" });
});

const plainTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
const fakeTui = () => ({ requestRender: () => {}, terminal: { rows: 30, columns: 80 } }) as any;

test("interview component renders tabs, options and the editor, and returns answers", () => {
	let result: unknown = "pending";
	const ui = createInterview(fakeTui(), plainTheme, [pick("a", "Auth"), pick("b", "Store", true)], (answers) => {
		result = answers;
	});
	const first = ui.render(60).join("\n");
	assert.match(first, /□ Auth .* □ Store .* Submit/);
	assert.match(first, /> 1\. A\n/);
	assert.match(first, /3\. Type something\./);
	ui.handleInput("\r");
	assert.equal(ui.state.tab, 1);
	assert.match(ui.render(60).join("\n"), /\[ \] A/);
	ui.handleInput(" ");
	assert.match(ui.render(60).join("\n"), /\[x\] A/);
	ui.handleInput("\u001b[B");
	ui.handleInput("\u001b[B");
	ui.handleInput("\r");
	assert.equal(ui.state.editing, true);
	for (const ch of "pg") ui.handleInput(ch);
	ui.handleInput("\r");
	assert.deepEqual(ui.state.answers.b, { selected: ["A"], freeform: "pg" });
	ui.handleInput("\t");
	assert.match(ui.render(60).join("\n"), /Store: A, "pg"[\s\S]*Press Enter to submit/);
	ui.handleInput("\r");
	assert.deepEqual(result, { a: { selected: ["A"] }, b: { selected: ["A"], freeform: "pg" } });
});

test("interview component reports cancel on escape", () => {
	let result: unknown = "pending";
	const ui = createInterview(fakeTui(), plainTheme, [pick("a", "A")], (answers) => {
		result = answers;
	});
	ui.handleInput("\u001b");
	assert.equal(result, undefined);
});

test("digit keys pick an option directly", () => {
	const state = run([pick("a", "A")], [{ type: "pick", index: 1 }]);
	assert.deepEqual(state.answers.a, { selected: ["B"] });
	assert.equal(run([pick("a", "A")], [{ type: "pick", index: 2 }]).editing, true, "the last number opens free text");
	assert.equal(run([pick("a", "A")], [{ type: "pick", index: 5 }]).cursor, 0);
});

function askUser() {
	let tool: any;
	register({ registerTool: (t: any) => (tool = t), registerEntryRenderer: () => {} } as any);
	return (params: any, ctx: any) => tool.execute("id", params, undefined, undefined, ctx);
}

test("ask_user returns answers with default ids and handles headless, dismissal and bad input", async () => {
	const execute = askUser();
	const params = { questions: [{ header: "Auth", question: "Auth?", options: [{ label: "A" }, { label: "B" }] }] };
	const picks = ["B"];
	const ctx = { mode: "rpc", hasUI: true, ui: { select: async () => picks.shift(), input: async () => undefined } };
	const answered = await execute(params, ctx);
	assert.equal(answered.content[0].text, "Auth: B");
	assert.equal(answered.details.questions[0].id, "q1");
	assert.match((await execute(params, ctx)).content[0].text, /dismissed/);
	assert.match((await execute(params, { ...ctx, hasUI: false })).content[0].text, /no interactive UI/);
	const bad = { questions: [{ header: "X", question: "X?", options: [{ label: "only" }] }] };
	assert.match((await execute(bad, ctx)).content[0].text, /Error: .*at least 2 options/);
});

test("ask_user makes explicit and default ids unique", async () => {
	const execute = askUser();
	const options = [{ label: "A" }, { label: "B" }];
	const ctx = { mode: "rpc", hasUI: true, ui: { select: async () => "A", input: async () => undefined } };
	const result = await execute({ questions: [{ id: "q2", header: "X", question: "X?", options }, { header: "Y", question: "Y?", options }] }, ctx);
	assert.deepEqual(result.details.questions.map((q: any) => q.id), ["q2", "q2-2"]);
	assert.equal(result.content[0].text, "X: A\nY: A");
});

test("long headers are cut to 12 characters and tabs never split across lines", async () => {
	const qs = [1, 2, 3, 4].map((i) => ({ ...pick(`q${i}`, `Storage layer choice ${i}`), question: "Which persistence layer should store the phone number?" }));
	const ui = createInterview(fakeTui(), plainTheme, qs, () => {});
	const lines = ui.render(40);
	assert.ok(lines.every((l) => visibleWidth(l) <= 40), lines.join("\n"));
	const tabLines = lines.slice(0, lines.indexOf("")).map(stripAnsi);
	const labels = tabLines.join(" ").match(/□ [^□]+?(?= {2}|$| Submit)/g) ?? [];
	assert.equal(labels.length, 4, tabLines.join("\n"));
	for (const label of labels) assert.equal(label.trim(), "□ Storage lay…");
});

test("layoutTabs wraps whole tabs and cuts a tab wider than the line", () => {
	assert.deepEqual(layoutTabs(["aaaa", "bbbb", "cccc"], 11), [" aaaa bbbb", " cccc"]);
	assert.deepEqual(layoutTabs(["x".repeat(20)], 8).map(stripAnsi), [` ${"x".repeat(6)}…`]);
});

test("review overlay wraps a long title to the screen width", async () => {
	let component: any;
	const ctx: any = {
		mode: "tui",
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					component = factory(fakeTui(), plainTheme, undefined, resolve);
					component.handleInput("\r");
				}),
		},
	};
	initTheme("dark");
	const pi: any = { appendEntry: () => {} };
	const title = `Spec: ${"very long feature title ".repeat(4)}`;
	const result = await reviewDocument(pi, ctx, { title, markdown: `# Doc\n\n${"word ".repeat(60)}` });
	assert.deepEqual(result, { action: "accept" });
	const lines: string[] = component.render(40);
	assert.ok(lines.every((l) => visibleWidth(l) <= 40), lines.join("\n"));
	assert.ok(lines.slice(1, 4).join(" ").includes("very long feature title very"));
});

test("ask_user requires multiSelect and the fallback collects several picks", async () => {
	let tool: any;
	register({ registerTool: (t: any) => (tool = t), registerEntryRenderer: () => {} } as any);
	assert.ok(tool.parameters.properties.questions.items.required.includes("multiSelect"));
	assert.ok(tool.promptGuidelines.some((g: string) => g.includes("multiSelect true")));
	const picks = ["A", "B", "Done"];
	const ctx = { mode: "rpc", hasUI: true, ui: { select: async () => picks.shift(), input: async () => undefined } };
	const options = [{ label: "A" }, { label: "B" }, { label: "C" }];
	const result = await tool.execute("id", { questions: [{ header: "X", question: "X?", options, multiSelect: true }] }, undefined, undefined, ctx);
	assert.equal(result.content[0].text, "X: A; B");
	const done = ["C", "Done"];
	const ctx2 = { ...ctx, ui: { ...ctx.ui, select: async () => done.shift() } };
	const one = await tool.execute("id", { questions: [{ header: "X", question: "X?", options, multiSelect: true }] }, undefined, undefined, ctx2);
	assert.equal(one.content[0].text, "X: C");
});

test("fallback multi-select: free text keeps picks, exhausting options ends, cancel dismisses, single-select never offers Done", async () => {
	let tool: any;
	register({ registerTool: (t: any) => (tool = t), registerEntryRenderer: () => {} } as any);
	const options = [{ label: "A" }, { label: "B" }, { label: "C" }];
	const ask = async (multiSelect: boolean, picks: (string | undefined)[], typed?: string) => {
		const seen: { title: string; choices: string[] }[] = [];
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (title: string, choices: string[]) => {
					seen.push({ title, choices });
					return picks.shift();
				},
				input: async () => typed,
			},
		};
		const result = await tool.execute("id", { questions: [{ header: "X", question: "X?", options, multiSelect }] }, undefined, undefined, ctx);
		return { text: result.content[0].text, seen };
	};
	const freeform = await ask(true, ["A", "Type something."], "custom");
	assert.equal(freeform.text, "X: A; user wrote: custom");
	assert.deepEqual(freeform.seen[0].choices, ["A", "B", "C", "Type something."], "Done appears only after a pick");
	assert.deepEqual(freeform.seen[1], { title: "X? (picked: A)", choices: ["B", "C", "Type something.", "Done"] });
	assert.equal((await ask(true, ["A", "B", "C"])).text, "X: A; B; C");
	assert.match((await ask(true, ["A", undefined])).text, /dismissed/);
	const single = await ask(false, ["B"]);
	assert.equal(single.text, "X: B");
	assert.equal(single.seen.length, 1);
	assert.ok(!single.seen[0].choices.includes("Done"));
});
