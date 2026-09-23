import assert from "node:assert/strict";
import { test } from "node:test";
import register, { isProtected } from "../agent/extensions/protected-paths/index.ts";

test("blocks secrets, git internals and dependencies", () => {
	for (const path of [".env", "./.env", "/abs/repo/.env.local", ".git", ".git/config", "../x/.git/HEAD", "a/node_modules/x.js", "agent/auth.json"]) {
		assert.ok(isProtected(path), path);
	}
});

test("allows ordinary files", () => {
	for (const path of ["src/env.ts", ".envrc", ".environment", "foo.git/x", "gitignore", "README.md"]) {
		assert.ok(!isProtected(path), path);
	}
});

function load() {
	let handler: any;
	const commands: string[] = [];
	register({
		on: (event: string, fn: any) => {
			if (event === "tool_call") handler = fn;
		},
		registerCommand: (name: string) => commands.push(name),
	} as any);
	const notified: string[] = [];
	const ctx = (hasUI: boolean) => ({ hasUI, ui: { notify: (msg: string) => notified.push(msg) } });
	return { handler, commands, notified, ctx };
}

test("tool_call handler blocks write and edit on protected paths", async () => {
	const { handler, commands, notified, ctx } = load();
	assert.deepEqual(commands, ["protected-paths"]);

	const blocked = await handler({ toolName: "write", input: { path: ".env" } }, ctx(true));
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /\.env/);
	assert.equal(notified.length, 1);

	assert.equal((await handler({ toolName: "edit", input: { path: ".git/config" } }, ctx(false))).block, true);
	assert.equal(notified.length, 1, "no notify without UI");
});

test("tool_call handler ignores other tools, safe paths and missing paths", async () => {
	const { handler, ctx } = load();
	assert.equal(await handler({ toolName: "read", input: { path: ".env" } }, ctx(false)), undefined);
	assert.equal(await handler({ toolName: "write", input: { path: "README.md" } }, ctx(false)), undefined);
	assert.equal(await handler({ toolName: "write", input: {} }, ctx(false)), undefined);
});
