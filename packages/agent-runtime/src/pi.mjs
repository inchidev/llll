import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'

/** A runtime instance serves one authorized execution identity, never an entire Server. */
export async function openPi(input, { directory, emit, callTool, signal }) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const cwd = join(directory, 'work')
  await mkdir(cwd, { recursive: true })
  const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  runtime.registerProvider('l4', {
    baseUrl: input.modelGateway.url,
    apiKey: input.modelGateway.token,
    api: 'openai-completions',
    models: [{ id: input.modelGateway.model, name: input.modelGateway.model, reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096 }],
  })
  const model = runtime.getModel('l4', input.modelGateway.model)
  if (!model) throw new Error('Configured model is unavailable')
  const loader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
  const customTools = input.tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
    execute: async (id, args, toolSignal) => {
      const value = await callTool({ callId: id, name: tool.name, arguments: args }, toolSignal)
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} }
    },
  }))
  // The container is the filesystem boundary. No host paths, credentials or Docker socket are mounted.
  const tools = [...customTools.map(tool => tool.name), ...(input.computer ? ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] : [])]
  let sessionManager
  try {
    const file = (await readFile(join(directory, 'session-path'), 'utf8')).trim()
    // Never restore a path supplied by the model or an external caller.
    if (!file.startsWith(directory + '/')) throw new Error('Invalid saved session path')
    sessionManager = SessionManager.open(file, join(directory, 'sessions'), cwd)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    sessionManager = SessionManager.create(cwd, join(directory, 'sessions'))
  }
  const { session } = await createAgentSession({ cwd, agentDir: directory, modelRuntime: runtime, model,
    tools, customTools, resourceLoader: loader, sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } }),
    thinkingLevel: 'off',
  })
  const stop = () => { void session.abort() }
  signal?.addEventListener('abort', stop, { once: true })
  let steps = 0
  let limited = false
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'turn_start' && ++steps > input.maxSteps) { limited = true; stop() }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') emit({ type: 'text', text: event.assistantMessageEvent.delta })
    if (event.type === 'tool_execution_start') emit({ type: 'tool', name: event.toolName })
  })
  return {
    async run(prompt) {
      try {
        if (signal?.aborted) throw new Error('Run cancelled')
        await session.prompt(prompt)
        const file = sessionManager.getSessionFile()
        if (file) await writeFile(join(directory, 'session-path'), file, { mode: 0o600 })
        if (limited) throw new Error('Agent step limit reached')
        if (signal?.aborted) throw new Error('Run cancelled')
        const messages = session.messages
        const last = [...messages].reverse().find(message => message.role === 'assistant')
        if (last?.stopReason === 'error') throw new Error(last.errorMessage || 'Model request failed')
        return { text: last?.content.filter(part => part.type === 'text').map(part => part.text).join('') || '', steps }
      } finally {
        unsubscribe()
        signal?.removeEventListener('abort', stop)
        session.dispose()
      }
    },
    abort: stop,
  }
}
