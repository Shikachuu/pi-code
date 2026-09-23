import { CODE_REVIEWER_SCHEMA, COMMENT_AUDITOR_SCHEMA, TEST_ENGINEER_SCHEMA } from "./report.ts";
import { formatScope, type Scope } from "./scope.ts";

export const VERIFY_AGENTS = ["code-reviewer", "test-engineer", "comment-auditor"] as const;

export const VERIFY_SCRIPT = `export const meta = {
  name: 'verify',
  description: 'Run three parallel read-only verification agents over a git scope',
  phases: [{ title: 'Verify' }],
}
phase('Verify')
const results = await parallel([
  () => agent(args.codeReviewer.prompt, { label: 'code-reviewer', tier: 'medium', agentType: 'code-reviewer', schema: args.codeReviewer.schema }),
  () => agent(args.testEngineer.prompt, { label: 'test-engineer', tier: 'medium', agentType: 'test-engineer', schema: args.testEngineer.schema }),
  () => agent(args.commentAuditor.prompt, { label: 'comment-auditor', tier: 'medium', agentType: 'comment-auditor', schema: args.commentAuditor.schema }),
])
return { codeReviewer: results[0], testEngineer: results[1], commentAuditor: results[2] }`;

function scopeBlock(scope: Scope): string {
	return `<scope>\n${formatScope(scope)}\n</scope>`;
}

export function verifyArgs(scope: Scope) {
	const block = scopeBlock(scope);
	return {
		codeReviewer: {
			prompt: `${block}\n\nReview this scope for correctness, readability, architecture, security and performance.`,
			schema: CODE_REVIEWER_SCHEMA,
		},
		testEngineer: {
			prompt: `${block}\n\nAssess test coverage and quality for this scope, and try running the test suite (or the closest smoke check).`,
			schema: TEST_ENGINEER_SCHEMA,
		},
		commentAuditor: {
			prompt: `${block}\n\nAudit every comment touched by or attached to this scope.`,
			schema: COMMENT_AUDITOR_SCHEMA,
		},
	};
}
