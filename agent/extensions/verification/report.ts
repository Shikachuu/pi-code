import type { Scope } from "./scope.ts";

const str = { type: "string" } as const;
const strList = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
});

export type Severity = "critical" | "important" | "nit";

export interface Finding {
	severity: Severity;
	file: string;
	line: number;
	issue: string;
	fix: string;
}

const FINDING_SCHEMA = obj({
	severity: { type: "string", enum: ["critical", "important", "nit"] },
	file: str,
	line: { type: "number" },
	issue: str,
	fix: str,
});

const BASE_REPORT = {
	verdict: { type: "string", enum: ["APPROVE", "REQUEST CHANGES"] },
	overview: str,
	findings: { type: "array", items: FINDING_SCHEMA },
	doneWell: strList,
};

export interface BaseReport {
	verdict: "APPROVE" | "REQUEST CHANGES";
	overview: string;
	findings: Finding[];
	doneWell: string[];
}

export interface CodeReviewerReport extends BaseReport {
	verificationStory: { testsReviewed: string; buildVerified: string; securityChecked: string };
}

export const CODE_REVIEWER_SCHEMA = obj({
	...BASE_REPORT,
	verificationStory: obj({ testsReviewed: str, buildVerified: str, securityChecked: str }),
});

export interface TestEngineerReport extends BaseReport {
	coverageGaps: string[];
	smokeTest: { commands: string[]; suite: string; manual: string; blocked: string[] };
}

export const TEST_ENGINEER_SCHEMA = obj({
	...BASE_REPORT,
	coverageGaps: strList,
	smokeTest: obj({ commands: strList, suite: str, manual: str, blocked: strList }),
});

export interface AuditItem {
	file: string;
	line: number;
	issue: string;
	fix?: string;
}

const AUDIT_ITEM_SCHEMA = obj({ file: str, line: { type: "number" }, issue: str, fix: str }, ["file", "line", "issue"]);

export interface CommentAuditorReport {
	verdict: "APPROVE" | "REQUEST CHANGES";
	overview: string;
	doneWell: string[];
	mustKill: AuditItem[];
	correctness: AuditItem[];
	nits: AuditItem[];
	kept: AuditItem[];
	skipped: string[];
}

export const COMMENT_AUDITOR_SCHEMA = obj({
	verdict: { type: "string", enum: ["APPROVE", "REQUEST CHANGES"] },
	overview: str,
	doneWell: strList,
	mustKill: { type: "array", items: AUDIT_ITEM_SCHEMA },
	correctness: { type: "array", items: AUDIT_ITEM_SCHEMA },
	nits: { type: "array", items: AUDIT_ITEM_SCHEMA },
	kept: { type: "array", items: AUDIT_ITEM_SCHEMA },
	skipped: strList,
});

export interface Reports {
	codeReviewer: CodeReviewerReport | null;
	testEngineer: TestEngineerReport | null;
	commentAuditor: CommentAuditorReport | null;
}

interface MergedFinding extends Finding {
	agents: string[];
}

const AGENT_ORDER = ["code-reviewer", "test-engineer", "comment-auditor"] as const;

function attribution(agents: string[]): string {
	const set = new Set(agents);
	if (AGENT_ORDER.every((a) => set.has(a))) return "[all]";
	return `[${AGENT_ORDER.filter((a) => set.has(a)).join(", ")}]`;
}

function auditToFindings(report: CommentAuditorReport | null): { agent: string; findings: Finding[] } {
	if (!report) return { agent: "comment-auditor", findings: [] };
	const findings: Finding[] = [
		...report.correctness.map((i) => ({ severity: "critical" as const, file: i.file, line: i.line, issue: i.issue, fix: i.fix ?? "" })),
		...report.mustKill.map((i) => ({ severity: "important" as const, file: i.file, line: i.line, issue: i.issue, fix: i.fix ?? "" })),
		...report.nits.map((i) => ({ severity: "nit" as const, file: i.file, line: i.line, issue: i.issue, fix: i.fix ?? "" })),
	];
	return { agent: "comment-auditor", findings };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, important: 2, nit: 1 };

function higherSeverity(a: Severity, b: Severity): Severity {
	return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function mergeFindings(reports: Reports): MergedFinding[] {
	const sources: { agent: string; findings: Finding[] }[] = [
		{ agent: "code-reviewer", findings: reports.codeReviewer?.findings ?? [] },
		{ agent: "test-engineer", findings: reports.testEngineer?.findings ?? [] },
		auditToFindings(reports.commentAuditor),
	];

	const byKey = new Map<string, MergedFinding>();
	for (const { agent, findings } of sources) {
		for (const f of findings) {
			const key = `${f.file}:${f.line}`;
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, { ...f, agents: [agent] });
				continue;
			}
			existing.severity = higherSeverity(existing.severity, f.severity);
			if (!existing.agents.includes(agent)) existing.agents.push(agent);
			if (!existing.issue.includes(f.issue)) existing.issue = `${existing.issue}; ${f.issue}`;
			if (f.fix && !existing.fix.includes(f.fix)) existing.fix = existing.fix ? `${existing.fix}; ${f.fix}` : f.fix;
		}
	}
	return [...byKey.values()];
}

export function verdict(reports: Reports, merged: MergedFinding[]): "APPROVE" | "REQUEST CHANGES" {
	if (reports.codeReviewer === null || reports.testEngineer === null || reports.commentAuditor === null) return "REQUEST CHANGES";
	if (reports.codeReviewer.verdict === "REQUEST CHANGES") return "REQUEST CHANGES";
	if (reports.testEngineer.verdict === "REQUEST CHANGES") return "REQUEST CHANGES";
	if (reports.commentAuditor.verdict === "REQUEST CHANGES") return "REQUEST CHANGES";
	if (merged.some((f) => f.severity === "critical" || f.severity === "important")) return "REQUEST CHANGES";
	return "APPROVE";
}

function bullet(text: string): string {
	return `- ${text}`;
}

function findingLine(f: MergedFinding): string {
	return bullet(`${attribution(f.agents)} ${f.file}:${f.line} ${f.issue}${f.fix ? ` -> ${f.fix}` : ""}`);
}

function auditLine(item: AuditItem, arrow: string): string {
	return bullet(`${item.file}:${item.line} ${item.issue}${item.fix ? ` ${arrow} ${item.fix}` : ""}`);
}

function section(title: string, lines: string[]): string {
	return `### ${title}\n${lines.length ? lines.join("\n") : "- none"}`;
}

export function renderSummary(scope: Scope, reports: Reports): string {
	const merged = mergeFindings(reports);
	const v = verdict(reports, merged);
	const critical = merged.filter((f) => f.severity === "critical").map(findingLine);
	const important = merged.filter((f) => f.severity === "important").map(findingLine);
	const nits = merged.filter((f) => f.severity === "nit").map(findingLine);

	const overviewParts = [reports.codeReviewer?.overview, reports.testEngineer?.overview, reports.commentAuditor?.overview].filter(Boolean);
	const overview = overviewParts.length ? overviewParts.join(" ") : "No reports were returned.";

	const doneWell = [...(reports.codeReviewer?.doneWell ?? []), ...(reports.testEngineer?.doneWell ?? []), ...(reports.commentAuditor?.doneWell ?? [])];

	const parts: string[] = [];
	parts.push("## Verification Summary");
	parts.push(`**Verdict:** ${v}`);
	parts.push(`**Scope:**\n${scope.target} (${scope.kind}) - ${scope.files.length} file(s). Commands: ${scope.commands.join("; ")}`);
	parts.push(`**Overview:** ${overview}`);
	parts.push(section("Critical", critical));
	parts.push(section("Important", important));
	parts.push(section("Nits", nits));

	parts.push(
		reports.testEngineer
			? section("Coverage Gaps (from test-engineer)", reports.testEngineer.coverageGaps.map(bullet))
			: "### Coverage Gaps (from test-engineer)\ntest-engineer did not return a report",
	);

	if (reports.testEngineer) {
		const st = reports.testEngineer.smokeTest;
		const lines = [
			bullet(`Commands: ${st.commands.join(", ") || "none"}`),
			bullet(`Suite: ${st.suite || "none"}`),
			bullet(`Manual: ${st.manual || "none"}`),
			...(st.blocked.length ? [bullet(`Blocked: ${st.blocked.join(", ")}`)] : []),
		];
		parts.push(section("Smoke Test Result (from test-engineer)", lines));
	} else {
		parts.push("### Smoke Test Result (from test-engineer)\ntest-engineer did not return a report");
	}

	if (reports.codeReviewer) {
		const vs = reports.codeReviewer.verificationStory;
		const lines = [bullet(`Tests reviewed: ${vs.testsReviewed}`), bullet(`Build verified: ${vs.buildVerified}`), bullet(`Security checked: ${vs.securityChecked}`)];
		parts.push(section("Verification Story (from code-reviewer)", lines));
	} else {
		parts.push("### Verification Story (from code-reviewer)\ncode-reviewer did not return a report");
	}

	if (reports.commentAuditor) {
		const a = reports.commentAuditor;
		const lines: string[] = [];
		lines.push("**MUST KILL**");
		lines.push(...(a.mustKill.length ? a.mustKill.map((i) => auditLine(i, "->")) : ["- none"]));
		lines.push("**Correctness**");
		lines.push(...(a.correctness.length ? a.correctness.map((i) => auditLine(i, "->")) : ["- none"]));
		lines.push("**Kept**");
		lines.push(...(a.kept.length ? a.kept.map((i) => auditLine(i, "-")) : ["- none"]));
		lines.push("**Skipped**");
		lines.push(...(a.skipped.length ? a.skipped.map(bullet) : ["- none"]));
		parts.push(`### Comment Audit (from comment-auditor)\n${lines.join("\n")}`);
	} else {
		parts.push("### Comment Audit (from comment-auditor)\ncomment-auditor did not return a report");
	}

	parts.push(section("What's Done Well", doneWell.map(bullet)));

	return parts.join("\n\n");
}
