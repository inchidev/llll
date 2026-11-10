import { proposalFiles } from './files.mjs'
import { gatewayUrl } from './gateway.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'

/** Pi's own tools for a box: shell, files and edits in the repository checkout, at local speed. */
export const NATIVE_TOOLS = Object.freeze(['read', 'write', 'edit', 'bash'])

/** What the model sees of generate_image: the Server draws, the box saves the picture where the model names. */
const IMAGE_PARAMETERS = { type: 'object', additionalProperties: false, required: ['prompt', 'path'], properties: {
  prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'Subject, style, framing and background of the picture.' },
  path: { type: 'string', minLength: 1, maxLength: 300, description: 'Where to save it in the checkout, such as assets/hero.png.' },
  aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] },
} }

/** A picture the Server drew for this Run, fetched once and written inside the checkout. */
export async function saveGeneratedImage(input, cwd, path, image, fetcher = fetch) {
  const target = resolve(cwd, path)
  const inside = relative(cwd, target)
  if (!inside || inside.startsWith('..') || inside.split(sep).includes('.git') || target === cwd) throw new Error('Save pictures inside the checkout, outside .git')
  const response = await fetcher(gatewayUrl(input, `images/${image.id}`), { headers: { Authorization: `Bearer ${input.modelGateway.token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`The picture could not be fetched (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return { path: inside.split(sep).join('/'), mediaType: image.mediaType, bytes: bytes.byteLength }
}

/**
 * A runtime instance serves one authorized execution identity, never an entire Server. Pi's native tools
 * never pass through callTool, so they run only on the Task's box (`box` mode, with `cwd` its checkout),
 * where the box and its egress layer are the boundary; anywhere else they are not even registered.
 */
export async function openPi(input, { directory, cwd: checkout, emit, callTool, signal }) {
  const native = input.computer === true && input.box === true
  if ((input.computer || input.box) && !native) throw new Error('Native computer tools run only on the Task’s box')
  if (native && typeof checkout !== 'string') throw new Error('A box runs Pi in its repository checkout')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const cwd = native ? checkout : join(directory, 'work')
  await mkdir(cwd, { recursive: true })
  const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  runtime.registerProvider('l4', {
    baseUrl: input.modelGateway.url,
    apiKey: input.modelGateway.token,
    api: 'openai-completions',
    models: [{ id: input.modelGateway.model, name: input.modelGateway.model, reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: input.modelGateway.contextWindow, maxTokens: input.modelGateway.maxOutputTokens }],
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
  // A Server tool never takes the name of a native one.
  const customTools = input.tools.filter(tool => !NATIVE_TOOLS.includes(tool.name)).map(tool => ({
    executionMode: 'sequential',
    ...(tool.deferred ? { exposure: 'deferred' } : {}),
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.name === 'publish_code_changes' ? { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false } : tool.name === 'generate_image' ? IMAGE_PARAMETERS : tool.parameters,
    execute: async (id, args, toolSignal) => {
      if (tool.name === 'publish_code_changes') args = { ...args, files: await proposalFiles(cwd) }
      if (tool.name === 'generate_image') {
        const { path, ...request } = args ?? {}
        if (!native || typeof path !== 'string') throw new Error('Pictures are saved only in a box checkout')
        const drawn = await callTool({ callId: id, name: tool.name, arguments: request }, toolSignal)
        return { content: [{ type: 'text', text: JSON.stringify(drawn?.image ? await saveGeneratedImage(input, cwd, path, drawn.image) : drawn) }], details: {} }
      }
      let value = await callTool({ callId: id, name: tool.name, arguments: args }, toolSignal)
      if (tool.name === 'get_tool_details' && input.tools.some(candidate => candidate.deferred && candidate.name === value?.tool?.name)) {
        session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), value.tool.name])])
        emit({ type: 'tool', name: value.tool.name, purpose: typeof value.purpose === 'string' ? value.purpose.slice(0, 240) : undefined })
        // Container publishing derives files from its checkout; show
        // the runtime's adapted arguments rather than asking the model for files.
        const selected = customTools.find(candidate => candidate.name === value.tool.name)
        if (selected) value = { ...value, tool: { ...value.tool, parameters: selected.parameters } }
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} }
    },
  }))
  // Outside a box, isolation alone cannot authorize an action: neither a stale computer flag nor restored
  // model context may enable native tools. The SDK allowlist controls registration as well as exposure.
  // Keep deferred definitions registered, then narrow the model's initial loadout explicitly.
  const serverTools = input.tools.map(tool => tool.name).filter(name => !NATIVE_TOOLS.includes(name))
  const tools = [...(native ? NATIVE_TOOLS : []), ...serverTools]
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
  const compaction = input.modelGateway.compaction
  const { session } = await createAgentSession({ cwd, agentDir: directory, modelRuntime: runtime, model,
    tools, customTools, resourceLoader: loader, sessionManager,
    // A dropped or overloaded model call is asked again with backoff instead of ending the turn; Pi
    // retries only transient errors (overload, 5xx, 429, a broken stream), never a refused or unpaid account.
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 }, compaction: { enabled: true,
      // pi-coding-agent has no background threshold; it takes the other two.
      ...(compaction ? { reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens } : {}) } }),
    thinkingLevel: 'off',
  })
  session.setActiveToolsByName([...(native ? NATIVE_TOOLS : []), ...input.tools.filter(tool => !tool.deferred && !NATIVE_TOOLS.includes(tool.name)).map(tool => tool.name)])
  const stop = () => { void session.abort() }
  signal?.addEventListener('abort', stop, { once: true })
  let steps = 0
  let limited = false
  // Steering waits until the prompt has begun; Pi reads it before its next model call.
  const waiting = []
  const deliver = text => session.steer(text).catch(() => { /* A turn that already ended hears it next time. */ })
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'turn_start' && waiting.length) for (const text of waiting.splice(0)) void deliver(text)
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
    /** A message the person sent during the turn; Pi reads it before its next model call. */
    steer(text) {
      if (session.isStreaming) void deliver(text)
      else waiting.push(text)
    },
  }
}
