import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_DIR, REPO, readJson } from "./helpers.ts";

test("pi version is identical across mise, npm, installed SDK and settings", () => {
	const miseToml = readFileSync(join(REPO, "mise.toml"), "utf8");
	const misePin = miseToml.match(/^pi\s*=\s*"([^"]+)"/m)?.[1];
	const devDep = readJson(join(REPO, "package.json")).devDependencies["@earendil-works/pi-coding-agent"];
	const installed = readJson(join(REPO, "node_modules/@earendil-works/pi-coding-agent/package.json")).version;
	const changelog = readJson(join(AGENT_DIR, "settings.json")).lastChangelogVersion;

	assert.match(misePin ?? "", /^\d+\.\d+\.\d+$/, "mise.toml must pin pi to an exact version");
	assert.deepEqual({ devDep, installed, changelog }, { devDep: misePin, installed: misePin, changelog: misePin });
});
