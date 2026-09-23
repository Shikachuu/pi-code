import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	type AgentDefinition,
	loadAgentRegistry,
	runWorkflow,
	type WorkflowRunOptions,
	type WorkflowRunResult,
} from "@quintinshaw/pi-dynamic-workflows";

export const SCOUT: AgentDefinition = {
	name: "sdd-scout",
	description: "Read-only, low-effort scout for spec-driven development",
	disallowedTools: ["edit", "write"],
	thinking: "low",
	prompt:
		"You are a read-only scout. Never modify files. Prefer rg and targeted reads over reading whole files. Stop as soon as you can answer, and report evidence exactly (path:line or URL).",
	source: "user",
};

export type WorkflowRunner = (script: string, options: WorkflowRunOptions) => Promise<WorkflowRunResult<unknown>>;

export interface RunSddOptions {
	label: string;
	maxAgents: number;
	run?: WorkflowRunner;
}

function progress(ctx: ExtensionContext, label: string) {
	let phase = "";
	const running = new Map<string, string>();
	let done = 0;
	let failed = 0;
	let tokens = 0;
	const show = () => {
		if (!ctx.hasUI) return;
		const lines = [
			`${label}${phase ? ` - ${phase}` : ""} - ${done} done${failed ? `, ${failed} failed` : ""}, ${running.size} running, ${tokens} tokens (Esc to stop)`,
			...[...running.values()].map((l) => `  - ${l}`),
		];
		ctx.ui.setWidget("sdd", lines);
	};
	return {
		options: {
			onPhase: (title: string) => {
				phase = title;
				show();
			},
			onAgentStart: (e: { id: string; label: string }) => {
				running.set(e.id, e.label);
				show();
			},
			onAgentEnd: (e: { id: string; tokens?: number; error?: string }) => {
				running.delete(e.id);
				if (e.error) failed++;
				else done++;
				tokens += e.tokens ?? 0;
				show();
			},
		},
		clear: () => ctx.hasUI && ctx.ui.setWidget("sdd", undefined),
	};
}

export async function runSdd<T>(ctx: ExtensionContext, script: string, args: unknown, opts: RunSddOptions): Promise<T> {
	const registry = loadAgentRegistry(ctx.cwd);
	if (!registry.has(SCOUT.name)) registry.set(SCOUT.name, SCOUT);
	const abort = new AbortController();
	const stopOnEscape =
		ctx.mode === "tui"
			? ctx.ui.onTerminalInput((data) => {
					if (!matchesKey(data, Key.escape)) return undefined;
					abort.abort();
					return { consume: true };
				})
			: undefined;
	const view = progress(ctx, opts.label);
	try {
		const result = await (opts.run ?? runWorkflow)(script, {
			args,
			cwd: ctx.cwd,
			mainModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			modelRegistry: ctx.modelRegistry,
			agentRegistry: registry,
			providerMiddlewareExtensions: ["pi-web-access"],
			concurrency: 10,
			maxAgents: opts.maxAgents,
			signal: abort.signal,
			persistLogs: false,
			...view.options,
		});
		if (abort.signal.aborted) throw new Error(`${opts.label} was stopped`);
		if (result.result == null) throw new Error(`${opts.label} returned no result`);
		return result.result as T;
	} finally {
		stopOnEscape?.();
		view.clear();
	}
}
