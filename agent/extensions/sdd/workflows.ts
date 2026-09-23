import { SPEC_TEMPLATE } from "./prompts.ts";

export const MAX_PROBES = 10;

export const SINGLE_SCRIPT = `export const meta = {
  name: 'sdd_single',
  description: 'Run one spec-driven-development agent',
  phases: [{ title: 'Run' }],
}
phase('Run')
return await agent(args.prompt, { label: args.label, tier: args.tier, schema: args.schema })`;

export const ENRICH_SCRIPT = `export const meta = {
  name: 'sdd_spec_enrich',
  description: 'Enrich a feature request before drafting its spec',
  phases: [{ title: 'Enrich' }],
}
phase('Enrich')
const results = await parallel([
  () => agent(args.scope.prompt, { label: 'scope', tier: 'small', schema: args.scope.schema }),
  () => agent(args.repo.prompt, { label: 'repo context', tier: 'small', agentType: 'sdd-scout', schema: args.repo.schema }),
  () => agent(args.questions.prompt, { label: 'open questions', tier: 'small', schema: args.questions.schema }),
])
return { scope: results[0], repo: results[1], questions: results[2] }`;

export const DISCOVERY_SCRIPT = `export const meta = {
  name: 'sdd_discovery',
  description: 'Low-effort parallel discovery for a feature spec',
  phases: [{ title: 'Probe plan' }, { title: 'Probe' }, { title: 'Synthesize' }],
}
phase('Probe plan')
const plan = await agent(args.plan.prompt, { label: 'plan probes', tier: 'small', schema: args.plan.schema })
let probes = plan && Array.isArray(plan.probes) ? plan.probes.filter((p) => p && p.question) : []
if (probes.length === 0) probes = [args.fallbackProbe]
probes = probes.slice(0, args.maxProbes)

phase('Probe')
const found = await parallel(probes.map((p, i) => () =>
  agent(
    args.probe.prompt + '\\n\\n<probe>\\n' + JSON.stringify(p, null, 2) + '\\n</probe>' + (p.kind === 'web' ? '\\n\\n' + args.probe.web : ''),
    { label: 'probe ' + (i + 1) + ': ' + p.title, tier: 'small', agentType: 'sdd-scout', schema: args.probe.schema }
  )
))
const results = probes.map((probe, i) => ({ probe, result: found[i] }))

phase('Synthesize')
const report = await agent(
  args.synth.prompt + '\\n\\n<probe-results>\\n' + JSON.stringify(results, null, 2) + '\\n</probe-results>',
  { label: 'synthesize', tier: 'small', schema: args.synth.schema }
)
return { probes, results, markdown: report && report.markdown }`;

export const RESEARCH_SCRIPT = `export const meta = {
  name: 'sdd_research',
  description: 'Deep web research on one topic of a feature',
  phases: [{ title: 'Queries' }, { title: 'Gather' }, { title: 'Verify' }, { title: 'Report' }],
}
phase('Queries')
const plan = await agent(args.queries.prompt, { label: 'plan queries', tier: 'small', schema: args.queries.schema })
const planned = plan && Array.isArray(plan.queries) ? plan.queries.filter((q) => typeof q === 'string' && q.trim()) : []
const queries = (planned.length ? planned : [args.question]).slice(0, args.angles)

phase('Gather')
const gathered = await parallel(queries.map((q, i) => () =>
  agent(args.gather.prompt + '\\n\\nQuery: ' + q, { label: 'research ' + (i + 1), tier: 'small', agentType: 'sdd-scout', schema: args.gather.schema })
))
const sources = gathered.filter(Boolean).flatMap((g) => g.sources || [])

phase('Verify')
const verdict = await agent(
  args.verify.prompt + '\\n\\nSOURCES JSON:\\n' + JSON.stringify(sources),
  { label: 'cross-check', tier: 'medium', schema: args.verify.schema }
)

phase('Report')
return await agent(
  args.report.prompt + '\\n\\nSUPPORTED CLAIMS JSON:\\n' + JSON.stringify((verdict && verdict.supported) || []),
  { label: 'write report', tier: 'medium', schema: args.report.schema }
)`;

const str = { type: "string" } as const;
const strList = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
});

const QUESTION_SCHEMA = obj({
	questions: {
		type: "array",
		maxItems: 4,
		items: obj(
			{
				id: str,
				header: str,
				question: str,
				options: { type: "array", minItems: 2, maxItems: 4, items: obj({ label: str, description: str }, ["label"]) },
				multiSelect: { type: "boolean" },
			},
			["id", "header", "question", "options", "multiSelect"],
		),
	},
});

const FINDINGS_SCHEMA = obj({
	findings: { type: "array", items: obj({ claim: str, evidence: strList }) },
	answered: strList,
	gaps: strList,
});

const WEB_TOOLS =
	"Call web_enable first to activate the web tools. Then use web_search and fetch_content. Report only what fetched pages say, with the exact URL.";

const withMemory = (text: string, memory: string) => (memory ? `${text}\n\n${memory}` : text);

export interface EnrichResult {
	scope?: { goal: string; inScope: string[]; nonGoals: string[]; assumptions: string[] };
	repo?: { stack: string; areas: { path: string; why: string }[]; patterns: string[] };
	questions?: {
		questions: {
			id: string;
			header: string;
			question: string;
			options: { label: string; description?: string }[];
			multiSelect?: boolean;
		}[];
	};
}

export function enrichArgs(request: string, memory: string) {
	const req = `<request>\n${request}\n</request>`;
	return {
		scope: {
			prompt: withMemory(
				`${req}\n\nRestate what this change is for. Give the goal in one sentence, what is in scope, what is explicitly out of scope, and the assumptions you are making. Do not read files.`,
				memory,
			),
			schema: obj({ goal: str, inScope: strList, nonGoals: strList, assumptions: strList }),
		},
		repo: {
			prompt: `${req}\n\nSkim this repository to ground the request. Use at most 8 tool calls. Report the language, framework and key libraries, the files or directories this change will likely touch (with why), and existing patterns the change should follow.`,
			schema: obj({ stack: str, areas: { type: "array", items: obj({ path: str, why: str }) }, patterns: strList }),
		},
		questions: {
			prompt: withMemory(
				`${req}\n\nList up to 4 product-level questions whose answers change what gets built, and that the request does not answer. Skip anything a developer can decide later. Each question needs a short header (at most 12 characters) and 2-4 distinct options, recommended option first. Set multiSelect true when more than one option can apply. Return an empty list when the request is clear.`,
				memory,
			),
			schema: QUESTION_SCHEMA,
		},
	};
}

export function draftArgs(input: {
	request: string;
	enrichment: EnrichResult;
	answers: string;
	memory: string;
	draft?: string;
	feedback?: string;
}) {
	const context = `<request>\n${input.request}\n</request>\n\n<enrichment>\n${JSON.stringify(input.enrichment, null, 2)}\n</enrichment>${input.answers ? `\n\n<user-answers>\n${input.answers}\n</user-answers>` : ""}`;
	const task =
		input.draft && input.feedback
			? `Revise this spec draft to address the user's feedback. Keep everything the feedback does not touch.\n\n<draft>\n${input.draft}\n</draft>\n\n<feedback>\n${input.feedback}\n</feedback>`
			: "Write a feature spec from this input.";
	return {
		label: input.draft ? "revise spec" : "draft spec",
		tier: "small",
		prompt: withMemory(
			`${context}\n\n${task}\n\nThe spec describes what and why, not how. Use this markdown template:\n\n${SPEC_TEMPLATE}\n\nAlso return a short kebab-case slug for the feature (for example phone-number-field) and a title.`,
			input.memory,
		),
		schema: obj({ slug: str, title: str, markdown: str }),
	};
}

export function discoveryArgs(spec: string, existing: string | undefined, memory: string) {
	return {
		maxProbes: MAX_PROBES,
		fallbackProbe: { kind: "code", title: "related code", question: "Which files, modules and tests does this spec touch?", hints: "" },
		plan: {
			prompt: withMemory(
				`<spec>\n${spec}\n</spec>\n\nPlan a quick discovery pass that answers what a planner will need to know. Propose up to ${MAX_PROBES} independent probes. Use kind "code" for endpoints, handlers and call sites, "schema" for models, migrations and validation, "deps" for existing dependencies and versions, and "web" for library or standard research that depends on the stack. Each probe asks one concrete question and gives search hints.`,
				memory,
			),
			schema: obj({
				probes: {
					type: "array",
					maxItems: MAX_PROBES,
					items: obj({ kind: { type: "string", enum: ["code", "schema", "deps", "web"] }, title: str, question: str, hints: str }),
				},
			}),
		},
		probe: {
			prompt: `<spec>\n${spec}\n</spec>\n\nAnswer the probe below with low effort: use at most 10 tool calls. Cite evidence as path:line for code or a URL for web facts. List what you answered and what stays open.`,
			web: WEB_TOOLS,
			schema: FINDINGS_SCHEMA,
		},
		synth: {
			prompt: `<spec>\n${spec}\n</spec>${existing ? `\n\n<existing-discovery>\n${existing}\n</existing-discovery>\n\nMerge the new results into the existing discovery; keep still-valid findings and replace stale ones.` : ""}\n\nWrite discovery.md from the probe results. Sections: # Discovery, ## Summary, ## Findings (one subsection per probe, each finding with its evidence), ## Pre-answered questions, ## Remaining gaps, ## Relevant files. Keep evidence exactly as reported.`,
			schema: obj({ markdown: str }),
		},
	};
}

export function researchArgs(topic: string, spec: string, discovery: string | undefined) {
	const context = `<spec>\n${spec}\n</spec>${discovery ? `\n\n<discovery>\n${discovery}\n</discovery>` : ""}`;
	return {
		question: topic,
		angles: 4,
		queries: {
			prompt: `${context}\n\nPlan web research for this topic in the context of the feature above:\n${topic}\n\nProduce 4 diverse, specific search queries that together cover it.`,
			schema: obj({ queries: strList }),
		},
		gather: {
			prompt: `${WEB_TOOLS}\nSearch for the query, fetch the 2 most relevant results, and extract concrete, verifiable claims, each with the exact source URL. Do not invent sources.`,
			schema: obj({ sources: { type: "array", items: obj({ url: str, claims: strList }) } }),
		},
		verify: {
			prompt:
				"Cross-check these sources. Group claims that state the same fact. Keep a claim only if at least 2 distinct URLs or one clearly authoritative source support it. Drop claims that conflict or come from one weak source.",
			schema: obj({ supported: { type: "array", items: obj({ claim: str, sources: strList }) }, discarded: strList }, ["supported"]),
		},
		report: {
			prompt: `${context}\n\nTopic: ${topic}\n\nWrite a research report from the supported claims only. Relate them to the feature above: what they imply for it and what you recommend. Say so when the evidence is thin.`,
			schema: obj({
				summary: str,
				findings: { type: "array", items: obj({ claim: str, sources: strList }) },
				implications: strList,
				recommendation: str,
				openQuestions: strList,
			}),
		},
	};
}
