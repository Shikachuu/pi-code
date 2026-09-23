import { normalize } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROTECTED = [/(^|\/)\.env(\.|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)auth\.json$/];

export function isProtected(path: string): boolean {
	const normalized = normalize(path).replaceAll("\\", "/");
	return PROTECTED.some((re) => re.test(normalized));
}

// Guards against mistakes in write/edit only; bash can still touch these paths.
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const path = String(event.input.path ?? "");
		if (!isProtected(path)) return undefined;
		if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
		return { block: true, reason: `Path "${path}" is protected` };
	});

	pi.registerCommand("protected-paths", {
		description: "List path patterns the agent may not write or edit",
		handler: async (_args, ctx) => {
			ctx.ui.notify(PROTECTED.map((re) => re.source).join("\n"), "info");
		},
	});
}
