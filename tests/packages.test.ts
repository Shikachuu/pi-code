import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { AGENT_DIR, readJson } from "./helpers.ts";

// Pi installs npm:/git: sources itself with no lockfile; only local paths backed by package-lock.json are reproducible.
const REMOTE = /^(npm:|git:|git\+|https?:|ssh:|git@)/;

test("settings.packages only references local paths that exist", () => {
	const { packages = [] } = readJson(resolve(AGENT_DIR, "settings.json"));
	for (const entry of packages) {
		const source: string = typeof entry === "string" ? entry : entry.source;
		assert.doesNotMatch(source, REMOTE, `${source}: add it to package.json and reference ../node_modules/<name>`);
		assert.ok(existsSync(resolve(AGENT_DIR, source)), `${source} does not exist; run \`mise install\``);
	}
});

test("settings resource paths are local", () => {
	const settings = readJson(resolve(AGENT_DIR, "settings.json"));
	for (const key of ["extensions", "skills", "prompts", "themes"]) {
		for (const path of settings[key] ?? []) {
			assert.doesNotMatch(path, REMOTE, `${key}: ${path}`);
			assert.ok(!path.startsWith("~") && !path.startsWith("/"), `${key}: ${path} points outside the repo`);
		}
	}
});
