import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_DIR, REPO, readJson } from "./helpers.ts";

const INDIRECT = /^(\$\{?[A-Z_][A-Z0-9_]*\}?|!.+)$/;

test("models.json holds no literal credentials", () => {
	const { providers = {} } = readJson(join(AGENT_DIR, "models.json"));
	for (const [id, provider] of Object.entries<any>(providers)) {
		const values = [provider.apiKey, ...Object.values(provider.headers ?? {})];
		for (const model of provider.models ?? []) values.push(...Object.values(model.headers ?? {}));
		for (const value of values.filter((v) => v !== undefined)) {
			assert.match(String(value), INDIRECT, `${id}: use $ENV_VAR or !command, not a literal`);
		}
	}
});

test("pi state files are git-ignored", () => {
	const paths = ["auth.json", "trust.json", "models-store.json", "crashes.json", "sessions/x.jsonl", "bin/rg", "npm/x", "git/x"];
	const { stdout } = spawnSync("git", ["check-ignore", ...paths.map((p) => `agent/${p}`)], { cwd: REPO, encoding: "utf8" });
	assert.deepEqual(stdout.trim().split("\n").filter(Boolean), paths.map((p) => `agent/${p}`));
});
