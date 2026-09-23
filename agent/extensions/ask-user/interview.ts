import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect?: boolean;
	otherLabel?: string;
}

export interface Answer {
	selected: string[];
	freeform?: string;
}

export type Answers = Record<string, Answer>;

export type Action =
	| { type: "next" }
	| { type: "prev" }
	| { type: "up" }
	| { type: "down" }
	| { type: "select" }
	| { type: "toggle" }
	| { type: "cancel" }
	| { type: "pick"; index: number }
	| { type: "freeform"; text: string };

export interface State {
	questions: Question[];
	tab: number;
	cursor: number;
	answers: Answers;
	editing: boolean;
	outcome?: "submit" | "cancel";
}

export const DEFAULT_OTHER_LABEL = "Type something.";

export function initialState(questions: Question[]): State {
	return { questions, tab: 0, cursor: 0, answers: {}, editing: false };
}

export function hasSubmitTab(questions: Question[]): boolean {
	return questions.length > 1 || questions.some((q) => q.multiSelect);
}

export function isAnswered(answer: Answer | undefined): boolean {
	return !!answer && (answer.selected.length > 0 || !!answer.freeform);
}

export function allAnswered(state: State): boolean {
	return state.questions.every((q) => isAnswered(state.answers[q.id]));
}

export function isSubmitTab(state: State): boolean {
	return state.tab === state.questions.length;
}

function advance(state: State): State {
	if (!hasSubmitTab(state.questions)) return { ...state, outcome: "submit" };
	return { ...state, tab: state.tab + 1, cursor: 0 };
}

function withAnswer(state: State, id: string, answer: Answer): State {
	return { ...state, answers: { ...state.answers, [id]: answer } };
}

export function reduce(state: State, action: Action): State {
	if (state.outcome) return state;
	const tabCount = state.questions.length + (hasSubmitTab(state.questions) ? 1 : 0);
	const question = state.questions[state.tab];

	if (state.editing) {
		if (action.type === "cancel") return { ...state, editing: false };
		if (action.type !== "freeform" || !question) return state;
		const text = action.text.trim() || undefined;
		const previous = state.answers[question.id] ?? { selected: [] };
		if (question.multiSelect) {
			return { ...withAnswer(state, question.id, { selected: previous.selected, freeform: text }), editing: false };
		}
		const next = { ...withAnswer(state, question.id, { selected: [], freeform: text }), editing: false };
		return text ? advance(next) : next;
	}

	switch (action.type) {
		case "next":
		case "prev": {
			if (tabCount <= 1) return state;
			const step = action.type === "next" ? 1 : -1;
			return { ...state, tab: (state.tab + step + tabCount) % tabCount, cursor: 0 };
		}
		case "cancel":
			return { ...state, outcome: "cancel" };
		case "freeform":
			return state;
	}

	if (!question) {
		if (action.type === "select" && allAnswered(state)) return { ...state, outcome: "submit" };
		return state;
	}

	const otherIndex = question.options.length;
	switch (action.type) {
		case "pick":
			if (action.index > otherIndex) return state;
			return reduce({ ...state, cursor: action.index }, { type: "select" });
		case "up":
			return { ...state, cursor: Math.max(0, state.cursor - 1) };
		case "down":
			return { ...state, cursor: Math.min(otherIndex, state.cursor + 1) };
		case "toggle":
		case "select": {
			if (state.cursor === otherIndex) return { ...state, editing: true };
			const label = question.options[state.cursor].label;
			const previous = state.answers[question.id] ?? { selected: [] };
			if (question.multiSelect) {
				const selected = previous.selected.includes(label)
					? previous.selected.filter((l) => l !== label)
					: [...previous.selected, label];
				return withAnswer(state, question.id, { ...previous, selected });
			}
			if (action.type === "toggle") return state;
			return advance(withAnswer(state, question.id, { selected: [label] }));
		}
	}
}

export function keyToAction(data: string): Action | undefined {
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return { type: "next" };
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return { type: "prev" };
	if (matchesKey(data, Key.up)) return { type: "up" };
	if (matchesKey(data, Key.down)) return { type: "down" };
	if (matchesKey(data, Key.enter)) return { type: "select" };
	if (matchesKey(data, Key.space)) return { type: "toggle" };
	if (matchesKey(data, Key.escape)) return { type: "cancel" };
	if (/^[1-9]$/.test(data)) return { type: "pick", index: Number(data) - 1 };
	return undefined;
}

export function formatAnswers(questions: Question[], answers: Answers): string {
	return questions
		.map((q) => {
			const answer = answers[q.id] ?? { selected: [] };
			const parts = [...answer.selected];
			if (answer.freeform) parts.push(`user wrote: ${answer.freeform}`);
			return `${q.header}: ${parts.join("; ") || "(no answer)"}`;
		})
		.join("\n");
}

export function validateQuestions(questions: Question[]): string | undefined {
	if (questions.length === 0) return "No questions provided";
	const ids = new Set<string>();
	for (const q of questions) {
		if (ids.has(q.id)) return `Duplicate question id "${q.id}"`;
		ids.add(q.id);
		if (q.options.length < 2) return `Question "${q.header}" needs at least 2 options`;
	}
	return undefined;
}

export interface InterviewComponent extends Component {
	handleInput(data: string): void;
	readonly state: State;
}

export function createInterview(
	tui: TUI,
	theme: Theme,
	questions: Question[],
	onDone: (answers: Answers | undefined) => void,
): InterviewComponent {
	let state = initialState(questions);
	let cached: string[] | undefined;
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	function dispatch(action: Action) {
		const wasEditing = state.editing;
		state = reduce(state, action);
		if (state.editing && !wasEditing) {
			const q = state.questions[state.tab];
			editor.setText((q && state.answers[q.id]?.freeform) ?? "");
		}
		cached = undefined;
		tui.requestRender();
		if (state.outcome === "submit") onDone(state.answers);
		if (state.outcome === "cancel") onDone(undefined);
	}

	editor.onSubmit = (text) => dispatch({ type: "freeform", text });

	function render(width: number): string[] {
		if (cached) return cached;
		const w = Math.max(1, width);
		const lines: string[] = [];
		const add = (prefix: string, text: string) => {
			const pw = visibleWidth(prefix);
			const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
			wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${line}`));
		};

		if (hasSubmitTab(questions)) {
			const tabs = questions.map((q, i) => {
				const done = isAnswered(state.answers[q.id]);
				const text = ` ${done ? "■" : "□"} ${q.header} `;
				return i === state.tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(done ? "success" : "muted", text);
			});
			const submit = " Submit ";
			tabs.push(
				isSubmitTab(state)
					? theme.bg("selectedBg", theme.fg("text", submit))
					: theme.fg(allAnswered(state) ? "success" : "dim", submit),
			);
			add(" ", tabs.join(" "));
			lines.push("");
		}

		const q = questions[state.tab];
		if (!q) {
			add(" ", theme.fg("accent", theme.bold("Review your answers")));
			lines.push("");
			for (const question of questions) {
				const answer = state.answers[question.id];
				const parts = answer ? [...answer.selected, ...(answer.freeform ? [`"${answer.freeform}"`] : [])] : [];
				add(" ", `${theme.fg("muted", `${question.header}: `)}${theme.fg("text", parts.join(", ") || "-")}`);
			}
			lines.push("");
			if (allAnswered(state)) add(" ", theme.fg("success", "Press Enter to submit"));
			else {
				const missing = questions.filter((x) => !isAnswered(state.answers[x.id])).map((x) => x.header);
				add(" ", theme.fg("warning", `Unanswered: ${missing.join(", ")}`));
			}
		} else {
			add(" ", theme.fg("text", theme.bold(q.question)));
			lines.push("");
			const answer = state.answers[q.id];
			const rows = [...q.options, { label: q.otherLabel ?? DEFAULT_OTHER_LABEL, description: answer?.freeform }];
			rows.forEach((opt, i) => {
				const isOther = i === q.options.length;
				const active = i === state.cursor;
				const chosen = isOther ? !!answer?.freeform : !!answer?.selected.includes(opt.label);
				const mark = q.multiSelect && !isOther ? (chosen ? "[x] " : "[ ] ") : chosen ? "* " : "";
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				add(prefix, theme.fg(active ? "accent" : "text", `${i + 1}. ${mark}${opt.label}`));
				if (opt.description) add("     ", theme.fg("muted", opt.description));
			});
			if (state.editing) {
				lines.push("");
				for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
			}
		}

		lines.push("");
		const help = state.editing
			? "Enter save - Esc back"
			: `${hasSubmitTab(questions) ? "Tab/Shift+Tab switch - " : ""}Up/Down or 1-9 pick - Enter select${q?.multiSelect ? " - Space toggle" : ""} - Esc cancel`;
		add(" ", theme.fg("dim", help));
		cached = lines;
		return lines;
	}

	return {
		get state() {
			return state;
		},
		render,
		invalidate() {
			cached = undefined;
		},
		handleInput(data: string) {
			if (state.editing && !matchesKey(data, Key.escape)) {
				editor.handleInput(data);
				cached = undefined;
				tui.requestRender();
				return;
			}
			const action = keyToAction(data);
			if (action) dispatch(action);
		},
	};
}

async function fallbackInterview(ctx: ExtensionContext, questions: Question[]): Promise<Answers | undefined> {
	const answers: Answers = {};
	for (const q of questions) {
		const other = q.otherLabel ?? DEFAULT_OTHER_LABEL;
		const choice = await ctx.ui.select(q.question, [...q.options.map((o) => o.label), other]);
		if (choice === undefined) return undefined;
		if (choice !== other) {
			answers[q.id] = { selected: [choice] };
			continue;
		}
		const text = await ctx.ui.input(q.question);
		if (text === undefined) return undefined;
		answers[q.id] = { selected: [], freeform: text.trim() || undefined };
	}
	return answers;
}

export async function interview(ctx: ExtensionContext, questions: Question[]): Promise<Answers | undefined> {
	const error = validateQuestions(questions);
	if (error) throw new Error(error);
	if (ctx.mode === "tui") {
		return ctx.ui.custom<Answers | undefined>((tui, theme, _kb, done) => createInterview(tui, theme, questions, done));
	}
	if (ctx.hasUI) return fallbackInterview(ctx, questions);
	throw new Error("Interactive UI is not available in this mode");
}
