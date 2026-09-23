import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_DIR } from "./helpers.ts";

// Pi rewrites settings.json as JSON.stringify(settings, null, 2); matching it keeps runtime diffs to real value changes.
test("settings.json is in pi's own serialization", () => {
	const raw = readFileSync(join(AGENT_DIR, "settings.json"), "utf8");
	assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2));
});
