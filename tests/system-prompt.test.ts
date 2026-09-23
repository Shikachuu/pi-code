import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR, isolate, matchSnapshot, normalize } from "./helpers.ts";

const { cwd } = isolate();
const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
const piPackageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

test("effective system prompt matches snapshot", async () => {
	const { session } = await createAgentSession({ cwd, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(cwd) });
	try {
		matchSnapshot("system-prompt.txt", normalize(session.systemPrompt.replaceAll(piPackageDir, "<PI_PACKAGE>"), cwd));
	} finally {
		session.dispose();
	}
});
