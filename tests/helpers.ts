import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "..");
export const AGENT_DIR = join(REPO, "agent");

// Pi reads ~/.agents/skills and walks context files from / to cwd, so tests pin both
// to empty temp dirs to see only what agent/ provides.
export function isolate(): { home: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-harness-"));
	const home = join(root, "home");
	const cwd = join(root, "cwd");
	mkdirSync(home);
	mkdirSync(cwd);
	process.env.HOME = home;
	process.env.PI_OFFLINE = "1";
	return { home, cwd };
}

export function normalize(text: string, cwd: string): string {
	return text.replaceAll(cwd, "<CWD>").replaceAll(REPO, "<REPO>");
}

export function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function matchSnapshot(name: string, actual: string): void {
	const path = join(REPO, "tests", "snapshots", name);
	if (process.env.UPDATE_SNAPSHOTS) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, actual);
		return;
	}
	let expected: string;
	try {
		expected = readFileSync(path, "utf8");
	} catch {
		assert.fail(`missing snapshot ${name}; run \`mise run snapshot\``);
	}
	assert.equal(actual, expected, `snapshot ${name} changed; review, then run \`mise run snapshot\``);
}
