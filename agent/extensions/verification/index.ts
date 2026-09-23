import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAgentRegistry } from "@quintinshaw/pi-dynamic-workflows";
import { showDocument } from "../ask-user/review.ts";
import { runSdd, type WorkflowRunner } from "../sdd/runner.ts";
import type { Reports } from "./report.ts";
import { renderSummary } from "./report.ts";
import { formatScope, isLarge, resolveScope, type Scope } from "./scope.ts";
import { VERIFY_AGENTS, VERIFY_SCRIPT, verifyArgs } from "./workflow.ts";

export interface VerificationOptions {
	run?: WorkflowRunner;
}

function checkAgentRegistry(cwd: string): string | null {
	const registry = loadAgentRegistry(cwd);
	for (const name of VERIFY_AGENTS) {
		const def = registry.get(name);
		if (!def) return `agentType "${name}" is not registered. Expected agent/agents/${name}.md.`;
		const denied = def.disallowedTools ?? [];
		if (!denied.includes("edit") || !denied.includes("write")) {
			return `agentType "${name}" must deny both "edit" and "write" in disallowedTools.`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI, options: VerificationOptions = {}) {
	pi.registerCommand("verify", {
		description: "Run three parallel read-only verification agents over a git scope and render a Verification Summary",
		handler: async (args, ctx: ExtensionContext) => {
			try {
				await handleVerify(pi, ctx, args, options);
			} catch (error) {
				ctx.ui.notify(`/verify: ${(error as Error).message}`, "error");
			}
		},
	});
}

async function handleVerify(pi: ExtensionAPI, ctx: ExtensionContext, args: string, options: VerificationOptions) {
	const target = args.trim();

	let scope: Scope;
	try {
		scope = resolveScope(ctx.cwd, target || undefined);
	} catch (error) {
		return void ctx.ui.notify(`/verify: ${(error as Error).message}`, "error");
	}

	if (scope.files.length === 0 && scope.wholeFiles.length === 0) {
		return void ctx.ui.notify("Nothing to verify: no changes found for this scope", "info");
	}

	if (isLarge(scope.stats)) {
		ctx.ui.notify(`Large scope: ${scope.stats.files} files, +${scope.stats.insertions}/-${scope.stats.deletions} changed lines`, "warning");
	}

	const guardError = checkAgentRegistry(ctx.cwd);
	if (guardError) return void ctx.ui.notify(`/verify: ${guardError}`, "error");

	const reports = await runSdd<Reports>(ctx, VERIFY_SCRIPT, verifyArgs(scope), {
		label: "verify",
		maxAgents: 3,
		run: options.run,
	});

	const markdown = renderSummary(scope, reports);
	const verdictLine = markdown.match(/\*\*Verdict:\*\* (.+)/)?.[1] ?? "REQUEST CHANGES";

	showDocument(pi, { title: `Verify: ${target || "(default)"}`, markdown }, verdictLine);
	pi.sendMessage({ customType: "verify-report", content: markdown, display: false });
}

export { formatScope, resolveScope, isLarge };
