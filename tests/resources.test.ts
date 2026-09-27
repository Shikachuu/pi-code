import { expect, test } from 'vitest'

import { AGENT_DIR, isolate, matchSnapshot, normalize } from './helpers.ts'

const { cwd } = isolate()
const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent')

test('agent dir loads without diagnostics and matches snapshot', async () => {
  const loader = new DefaultResourceLoader({ cwd, agentDir: AGENT_DIR })
  await loader.reload()

  const skills = loader.getSkills()
  const prompts = loader.getPrompts()
  const themes = loader.getThemes()
  const extensions = loader.getExtensions()

  expect(skills.diagnostics).toEqual([])
  expect(prompts.diagnostics).toEqual([])
  expect(themes.diagnostics).toEqual([])
  expect(extensions.errors).toEqual([])

  const inventory = {
    skills: skills.skills.map((s) => ({ name: s.name, path: s.filePath, modelInvocable: !s.disableModelInvocation })),
    prompts: prompts.prompts.map((p) => ({ name: p.name, path: p.sourceInfo.path })),
    themes: themes.themes.map((t) => t.name),
    extensions: extensions.extensions.map((e) => ({ path: e.path, commands: [...e.commands.keys()].sort() })),
    contextFiles: loader.getAgentsFiles().agentsFiles.map((f) => f.path),
    systemPromptSource: loader.getSystemPromptSource()?.path ?? null,
    appendSystemPromptSources: loader.getAppendSystemPromptSources().map((s) => s.path),
  }
  matchSnapshot('resources.json', normalize(JSON.stringify(inventory, null, 2), cwd) + '\n')
})
