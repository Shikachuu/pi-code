export const SPEC_TEMPLATE = `# <Feature title>

## Goal
## Background
## Scope
## Non-goals
## Expected behaviour
## Constraints
## Assumptions
## Open questions`;

export const PLAN_TEMPLATE = `# Plan: <Feature title>

## Summary
## Decisions
- <decision>: <chosen option> - <why>
## Changes
- \`path/to/file\`: <what changes>
## Tasks
- [ ] 1. <task>
## Acceptance criteria
- <observable, testable criterion>
## Validation pipeline
- \`<command>\` - <what it proves>
## Risks
## Out of scope`;

export interface ResearchReport {
	question: string;
	summary: string;
	findings: { claim: string; sources: string[] }[];
	implications: string[];
	recommendation: string;
	openQuestions: string[];
}

function headingLines(lines: string[]): (string | undefined)[] {
	let fenced = false;
	return lines.map((line) => {
		if (/^\s*```/.test(line)) fenced = !fenced;
		const match = fenced ? null : /^(#{1,2})\s+(.*?)\s*$/.exec(line);
		return match ? `${match[1]} ${match[2].toLowerCase()}` : undefined;
	});
}

function sectionBounds(lines: string[], heading: string): { start: number; end: number } | undefined {
	const headings = headingLines(lines);
	const start = headings.indexOf(`## ${heading.toLowerCase()}`);
	if (start < 0) return undefined;
	const end = headings.findIndex((h, i) => i > start && h !== undefined);
	return { start, end: end < 0 ? lines.length : end };
}

function section(markdown: string, heading: string): string | undefined {
	const lines = markdown.split("\n");
	const bounds = sectionBounds(lines, heading);
	return bounds && lines.slice(bounds.start + 1, bounds.end).join("\n").trim();
}

export function replaceSection(markdown: string, heading: string, body: string): string {
	const lines = markdown.trimEnd().split("\n");
	const bounds = sectionBounds(lines, heading);
	const block = [`## ${heading}`, "", body, ""];
	if (!bounds) return [...lines, "", ...block].join("\n");
	return [...lines.slice(0, bounds.start), ...block, ...lines.slice(bounds.end)].join("\n").trimEnd() + "\n";
}

export function validatePlan(markdown: string): string[] {
	const errors: string[] = [];
	const tasks = section(markdown, "Tasks");
	if (!tasks || !/^\s*- \[[ x]\]/m.test(tasks)) errors.push('"## Tasks" needs at least one "- [ ]" checkbox item');
	const criteria = section(markdown, "Acceptance criteria");
	if (!criteria || !/^\s*[-*\d]/m.test(criteria)) errors.push('"## Acceptance criteria" needs at least one list item');
	const pipeline = section(markdown, "Validation pipeline");
	if (!pipeline || !/`[^`]+`/.test(pipeline)) errors.push('"## Validation pipeline" needs at least one command in backticks');
	return errors;
}

export function renderResearch(report: ResearchReport): string {
	const sources = [...new Set(report.findings.flatMap((f) => f.sources))];
	const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- None");
	return [
		`# Research: ${report.question}`,
		"## Question",
		report.question,
		"## Summary",
		report.summary,
		"## Findings",
		list(report.findings.map((f) => `${f.claim} (${f.sources.join(", ")})`)),
		"## Implications for this feature",
		list(report.implications),
		"## Recommendation",
		report.recommendation,
		"## Open questions",
		list(report.openQuestions),
		"## Sources",
		list(sources),
	].join("\n\n");
}

export interface PlanPromptInput {
	slug: string;
	dir: string;
	spec: string;
	discovery?: string;
	research: { path: string; content: string }[];
	memory: string;
}

export function planPrompt(input: PlanPromptInput): string {
	const research = input.research.map((r) => `<research path="${r.path}">\n${r.content}\n</research>`).join("\n\n");
	return `You are planning the implementation of feature "${input.slug}". Its files live in ${input.dir}.

<spec>
${input.spec}
</spec>

<discovery>
${input.discovery ?? "No discovery was run."}
</discovery>
${research ? `\n${research}\n` : ""}${input.memory ? `\n${input.memory}\n` : ""}
Work in this order:
1. Read the code the spec and discovery point at until you understand the change. Do not edit any file.
2. List the information gaps and technical decisions you cannot infer from these inputs or the repo. Resolve each one with the ask_user tool: batch up to 4 questions per call, 2-4 options each, recommended option first. Repeat until nothing is open.
3. Find the validation pipeline: mise tasks, package scripts, Makefile targets, CI workflows, test runners. If none exists or it is ambiguous, propose options with ask_user.
4. Write the plan in this format. Every acceptance criterion must be checkable by the validation pipeline or a stated manual step.

${PLAN_TEMPLATE}

5. Call sdd_save_plan with feature "${input.slug}", the full plan markdown, and the key decisions. If the user requests changes, revise and call it again.`;
}

export interface ImplementPromptInput {
	slug: string;
	plan: string;
	planPath: string;
	docs: string[];
}

export function implementPrompt(input: ImplementPromptInput): string {
	return `Implement feature "${input.slug}" by following its plan.

<plan path="${input.planPath}">
${input.plan}
</plan>

Reference files (read them when you need detail): ${input.docs.join(", ")}

Rules:
- Do the tasks in order. After finishing each task, tick its checkbox in ${input.planPath} with the edit tool.
- If a task is blocked or the plan is wrong, stop and ask with ask_user rather than guessing.
- When every task is done, run each command in the validation pipeline and check every acceptance criterion.
- Finish by calling sdd_complete with feature "${input.slug}" and one result per acceptance criterion: pass or fail, with evidence.`;
}
