import { z } from 'zod'

/**
 * A Project's network for its Agents' boxes (ADR 0010): closed by default, with windows. Presets and Project
 * hosts are open for every box of the Project; a Task window opens one more host for a stated time.
 *
 * Each preset is a fixed list of hosts. None carries a credential: the box holds none, so a preset reads
 * public packages and code. A Project secret bound to one of these hosts is the only way a credential goes there.
 */
export const NETWORK_PRESETS = {
  npm: { label: 'npm registry', description: 'Install npm packages.', hosts: ['registry.npmjs.org'] },
  pypi: { label: 'PyPI', description: 'Install Python packages with pip.', hosts: ['pypi.org', 'files.pythonhosted.org'] },
  crates: { label: 'crates.io', description: 'Fetch Rust crates with Cargo.', hosts: ['crates.io', 'index.crates.io', 'static.crates.io'] },
  github: { label: 'GitHub, read', description: 'Clone public repositories and download releases, without credentials.',
    hosts: ['github.com', 'codeload.github.com', 'api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] },
} as const satisfies Record<string, { label: string; description: string; hosts: readonly string[] }>
export type NetworkPreset = keyof typeof NETWORK_PRESETS
export const networkPresetIds = Object.keys(NETWORK_PRESETS) as [NetworkPreset, ...NetworkPreset[]]

/** Names that only resolve inside a network, never a public service. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.test', '.invalid', '.example', '.onion', '.arpa']
/**
 * A public DNS name, lowercase: no IP address, port, wildcard or local name. The egress layer checks every
 * name it resolves for a public address as well, so a name that points inside a network stays closed.
 */
export const egressHost = z.string().trim().toLowerCase().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u, 'Use a public host name such as api.example.com, without https://, a port, a path or a wildcard')
  .refine(host => !LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix)), 'Use a public host name, not a local one')

export const projectNetworkSchema = z.object({
  presets: z.array(z.enum(networkPresetIds)).max(networkPresetIds.length).default([]).transform(values => [...new Set(values)]),
  hosts: z.array(egressHost).max(50).default([]).transform(values => [...new Set(values)]),
}).strict()
export type ProjectNetwork = z.infer<typeof projectNetworkSchema>
export const CLOSED_NETWORK: ProjectNetwork = { presets: [], hosts: [] }

/**
 * A Project's Git flow for its Agents (ADR 0010): the branch prefix of an Agent's branch, who merges and how.
 * The target branch is always the repository's base branch. GitHub or Gitea branch protection stays the
 * ceiling: a push or merge it refuses is reported with its reason, never worked around.
 *
 * - person: the Agent pushes `<prefix><box id>` and opens a draft pull request; a person merges it.
 * - agent_after_checks: as person, and the Agent may also merge once every check of the head passed.
 * - direct_push: the approved commit goes straight to the base branch, as a fast-forward only. No pull request.
 */
export const gitMergeModes = ['person', 'agent_after_checks', 'direct_push'] as const
export type GitMergeMode = typeof gitMergeModes[number]
export const gitMergeMethods = ['squash', 'merge', 'rebase'] as const
export type GitMergeMethod = typeof gitMergeMethods[number]
export const DEFAULT_BRANCH_PREFIX = 'l4-agent/'
/**
 * The start of an Agent's branch name, which ends in its box's id. Git's ref rules, narrowed to plain names:
 * letters, digits, `.`, `_`, `-` and `/` between parts, ending in `/`, `-` or `_`.
 */
export const branchPrefix = z.string().trim().min(2).max(60)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*[/_-]$/u, 'Use letters, digits, dots, dashes and slashes, ending in / or -, such as l4-agent/')
  .refine(value => !/\.\.|\/\/|\/\.|\.\/|\.lock\/|@\{/u.test(value) && !value.startsWith('refs/'), 'Use a plain branch name prefix such as l4-agent/')
export const projectGitFlowSchema = z.object({
  branchPrefix: branchPrefix.default(DEFAULT_BRANCH_PREFIX),
  merge: z.enum(gitMergeModes).default('person'),
  method: z.enum(gitMergeMethods).default('squash'),
}).strict()
export type ProjectGitFlow = z.infer<typeof projectGitFlowSchema>
export const DEFAULT_GIT_FLOW: ProjectGitFlow = { branchPrefix: DEFAULT_BRANCH_PREFIX, merge: 'person', method: 'squash' }
/** The Git flow part of `projects.factory_json`, or the default: a person merges `l4-agent/<box>` by squash. */
export function projectGitFlow(factoryJson: string | null | undefined): ProjectGitFlow {
  if (!factoryJson) return DEFAULT_GIT_FLOW
  try {
    const parsed = projectGitFlowSchema.safeParse((JSON.parse(factoryJson) as { gitFlow?: unknown }).gitFlow ?? DEFAULT_GIT_FLOW)
    return parsed.success ? parsed.data : DEFAULT_GIT_FLOW
  } catch { return DEFAULT_GIT_FLOW }
}
export const GIT_MERGE_LABELS: Record<GitMergeMode, { label: string; description: string }> = {
  person: { label: 'A person merges', description: 'The Agent pushes its own branch and opens a draft pull request. A person merges it from the Task once its checks pass.' },
  agent_after_checks: { label: 'The Agent merges after checks', description: 'As above, and the Agent may merge its pull request itself once every check of its head passed. Branch protection still decides.' },
  direct_push: { label: 'Direct push', description: 'For experiments: the approved commit goes straight to the base branch as a fast-forward, without a pull request. Branch protection may refuse it.' },
}
export const GIT_METHOD_LABELS: Record<GitMergeMethod, string> = { squash: 'Squash and merge', merge: 'Merge commit', rebase: 'Rebase and merge' }

/** The network part of `projects.factory_json`; anything else in it (the Git flow) is kept as stored. */
export function projectNetwork(factoryJson: string | null | undefined): ProjectNetwork {
  if (!factoryJson) return CLOSED_NETWORK
  try {
    const parsed = projectNetworkSchema.safeParse((JSON.parse(factoryJson) as { network?: unknown }).network ?? CLOSED_NETWORK)
    return parsed.success ? parsed.data : CLOSED_NETWORK
  } catch { return CLOSED_NETWORK }
}
/** Every host a Project's network opens: its presets' hosts and its own. */
export const networkHosts = (network: ProjectNetwork) => [...new Set([...network.presets.flatMap(preset => NETWORK_PRESETS[preset].hosts), ...network.hosts])]

/** A Project secret's name, as its placeholder shows it: `L4_SECRET_<NAME>`. */
export const secretName = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,63}$/u, 'Use letters, digits and underscores, starting with a letter, such as TELEGRAM_TOKEN')
export const SECRET_PLACEHOLDER_PREFIX = 'L4_SECRET_'
export const secretPlaceholder = (name: string) => `${SECRET_PLACEHOLDER_PREFIX}${name}`
/** Every token that may be a placeholder; only an exact known placeholder is ever replaced. */
export const PLACEHOLDER_PATTERN = /L4_SECRET_[A-Z0-9_]+/gu
/** A value goes into headers, URLs and bodies: no control characters, and no more than a header holds. */
export const secretValue = z.string().min(1).max(8192).refine(value => ![...value].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f), 'A secret cannot contain line breaks or control characters')
export const projectSecretCreateSchema = z.object({ name: secretName, value: secretValue, hosts: z.array(egressHost).min(1).max(10).transform(values => [...new Set(values)]) }).strict()
export const projectSecretUpdateSchema = z.object({ value: secretValue.optional(), hosts: z.array(egressHost).min(1).max(10).transform(values => [...new Set(values)]).optional() }).strict()
  .refine(value => value.value !== undefined || value.hosts !== undefined, 'Change the value or the hosts')
/** A secret as anyone sees it: never its value. */
export type ProjectSecret = { id: string; name: string; placeholder: string; hosts: string[]; createdAt: string; updatedAt: string; lastUsedAt: string | null }

/** What the Agent asks for: one host for a while, and the Project secrets it needs there. */
export const windowToolSchema = z.object({
  host: egressHost.describe('The host to reach, such as api.telegram.org: a public host name without https://, port or path.'),
  minutes: z.number().int().min(1).max(480).describe('How long the host stays open for this Task, in minutes (at most 8 hours).'),
  secrets: z.array(secretName).max(10).default([]).describe('Names of Project secrets to use at this host, such as TELEGRAM_TOKEN; each must be bound to the host. Send the placeholder L4_SECRET_<NAME> and the egress layer puts the value in.'),
  reason: z.string().trim().min(1).max(500).describe('Why the Task needs this host, for the person who decides.'),
}).strict()
