import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchRoutePolicy, ROUTE_POLICIES } from '../../server/utils/route-policy'

const root = join(process.cwd(), 'server/api')
const routeFiles = (readdirSync(root, { recursive: true }) as string[])
  .filter(file => file.endsWith('.ts')).map(file => relative('', file).replace(/\.ts$/u, '')).sort()

describe('route policy', () => {
  it('classifies every API route, so a new route must say where it stands', () => {
    const unclassified = routeFiles.filter(route => !Object.hasOwn(ROUTE_POLICIES, route))
    expect(unclassified).toEqual([])
  })

  it('has no entry for a route that no longer exists', () => {
    expect(Object.keys(ROUTE_POLICIES).filter(route => !routeFiles.includes(route))).toEqual([])
  })

  it('names an action on every route', () => {
    for (const [route, policy] of Object.entries(ROUTE_POLICIES)) expect(policy.action, route).toMatch(/^[a-z-]+\.[a-z.-]+$/u)
  })

  it('keeps content routes inside a Space: only Server administration, sign-in and the caller’s own account stay out', () => {
    const outside = Object.entries(ROUTE_POLICIES).filter(([, policy]) => policy.scope === 'server' || policy.scope === 'unscoped' || policy.scope === 'account').map(([route]) => route)
    // Paths that hold a department's work. Anything matching here must be `space` or `active`.
    const content = /^(channels|messages|dms|mail|boards|tasks|task-|databases|database-|documents|canvases|canvas-|gadgets|projects|files|agent-runs\/\[id\]\/(?!gateway)|schedules)/u
    expect(outside.filter(route => content.test(route))).toEqual([])
  })

  it('resolves each file to its own route, parameters and all', () => {
    for (const route of Object.keys(ROUTE_POLICIES)) {
      const method = route.match(/\.(get|post|put|patch|delete)$/u)?.[1]?.toUpperCase() ?? 'POST'
      const path = `/api/${route.replace(/\.(get|post|put|patch|delete)$/u, '').replace(/\/index$/u, '').replace(/\[\.\.\.[a-z]+\]/u, 'rest').replace(/\[[A-Za-z]+\]/gu, 'value')}`
      expect(matchRoutePolicy(method, path)?.policy, route).toBe(ROUTE_POLICIES[route])
    }
  })

  it('prefers a literal route to a parameter, and finds the named parameter', () => {
    expect(matchRoutePolicy('GET', '/api/servers/s/channels/archived')?.policy).toBe(ROUTE_POLICIES['servers/[id]/channels/archived.get'])
    expect(matchRoutePolicy('POST', '/api/channels/c-1/messages')?.params).toEqual({ id: 'c-1' })
    expect(matchRoutePolicy('GET', '/api/agents/a-1/avatar')?.params).toEqual({ agentId: 'a-1' })
  })
})

describe('new resources', () => {
  // A column default would put a row in the default Space, whichever Space its creator is in.
  const SPACE_TABLES = /INSERT (?:OR \w+ )?INTO\s+(channels|channel_categories|projects|task_boards|database_definitions|documents|canvases|gadgets|mcp_outbound_connections|agent_environments|invites)\s*\(([^)]*)\)/gu
  const DRIZZLE_TABLES = /\.insert\((channels|channelCategories|projects|taskBoards|databaseDefinitions|documents|canvases|gadgets|mcpOutboundConnections|invites)\)/u
  const sources = ['server', 'workers'].flatMap(directory => (readdirSync(directory, { recursive: true }) as string[]).filter(file => file.endsWith('.ts')).map(file => join(directory, file)))
  // The first default-Space resources of a Server, and Threads, which inherit by trigger.
  const allowed = new Set(['server/utils/bootstrap.ts', 'server/utils/server-mail.ts', 'workers/mail-ingress.ts'])

  it('name their Space when inserted', () => {
    const offenders: string[] = []
    for (const path of sources) {
      if (allowed.has(path)) continue
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(SPACE_TABLES)) {
        if (!/\bspace_id\b/u.test(match[2]!) && !/\bparent_id\b/u.test(match[2]!)) offenders.push(`${path}: ${match[1]}`)
      }
      // A Thread (`parentId`) inherits its parent's Space by trigger.
      if (DRIZZLE_TABLES.test(text) && !/\b(?:spaceId|parentId)\b/u.test(text)) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
