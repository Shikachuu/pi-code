import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../agent/extensions/ask-user/index.ts";
import {
	type Action,
	createInterview,
	formatAnswers,
	initialState,
	type Question,
	reduce,
	type State,
	validateQuestions,
} from "../agent/extensions/ask-user/interview.ts";
import { reviewQuestion, toReviewResult } from "../agent/extensions/ask-user/review.ts";

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
