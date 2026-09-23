import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Mirrors pi-hermes-memory's on-disk layout (constants.ts ENTRY_DELIMITER, project.ts detectProject).
// Its sources are TypeScript inside node_modules, which Node will not type-strip, so they cannot be imported.
const ENTRY_DELIMITER = "\n§\n";
const MAX_CHARS = 4000;

export function parseEntries(markdown: string): string[] {
	return markdown
		.split(ENTRY_DELIMITER)
		.map((entry) => entry.replace(/<!--[\s\S]*?-->/g, "").trim())
		.filter(Boolean);
}

function repoRoot(cwd: string): string | undefined {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

export function projectMemoryFile(cwd: string, agentDir = getAgentDir()): string | undefined {
	const root = join(agentDir, "projects-memory");
	const names = [repoRoot(cwd), cwd].filter((p): p is string => !!p).map((p) => basename(resolve(p)));
	for (const name of names) {
		const file = join(root, name, "MEMORY.md");
		if (existsSync(file)) return file;
	}
	return undefined;
}

function readEntries(file: string | undefined): string[] {
	if (!file || !existsSync(file)) return [];
	return parseEntries(readFileSync(file, "utf8"));
}

export function memoryBlock(cwd: string, agentDir = getAgentDir()): string {
	const project = readEntries(projectMemoryFile(cwd, agentDir));
	const user = readEntries(join(agentDir, "pi-hermes-memory", "USER.md"));
	if (project.length === 0 && user.length === 0) return "";
	const sections: string[] = [];
	if (project.length) sections.push(`Project memory:\n${project.map((e) => `- ${e}`).join("\n")}`);
	if (user.length) sections.push(`User profile:\n${user.map((e) => `- ${e}`).join("\n")}`);
	const body = sections.join("\n\n");
	return `<memory>\n${body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n...(truncated)` : body}\n</memory>`;
}
