import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { AGENT_DIR, REPO, isolate, matchSnapshot, normalize } from "./helpers.ts";

const { cwd } = isolate();

test("pi on PATH is the pinned version", () => {
	const pin = readFileSync(join(REPO, "mise.toml"), "utf8").match(/^pi\s*=\s*"([^"]+)"/m)?.[1];
	assert.equal(execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(), pin, "run tests through `mise run test`");
});

test("pinned pi binary exposes the configured commands over RPC", { timeout: 30_000 }, async () => {
	const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline"], {
		cwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
		stdio: ["pipe", "pipe", "inherit"],
	});
	try {
		const lines = createInterface({ input: child.stdout });
		child.stdin.write(`${JSON.stringify({ id: "1", type: "get_commands" })}\n`);
		let response: any;
		for await (const line of lines) {
			const msg = JSON.parse(line);
			if (msg.type === "response" && msg.command === "get_commands") {
				response = msg;
				break;
			}
		}
		assert.ok(response?.success, "get_commands failed");
		const commands = response.data.commands
			.map((c: any) => ({ name: c.name, source: c.source, scope: c.sourceInfo?.scope, path: c.sourceInfo?.path }))
			.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
		matchSnapshot("commands.json", normalize(JSON.stringify(commands, null, 2), cwd) + "\n");
	} finally {
		child.kill();
	}
});
