import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { loadDataResources } from '../../server/utils/data-resources'

describe('documents and canvases', () => {
  it('stores rich documents and connected canvas items in the installation database', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    sqlite.exec(`
      INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('owner-role', 'owner', 'Owner', 1023);
      INSERT INTO identity_keys (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.com');
      INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('user-1', 'Owner', 'active', 'owner-role', CURRENT_TIMESTAMP);
      INSERT INTO database_definitions (id, name, created_by, archived_at) VALUES ('db-1', 'Archive', 'user-1', CURRENT_TIMESTAMP);
      INSERT INTO database_items (id, database_id, title, created_by, text_1) VALUES ('record-1', 'db-1', 'Acme', 'user-1', 'Private record body');
      INSERT INTO documents (id, title, content, created_by) VALUES ('doc-1', 'Plan', '<p>Hello</p>', 'user-1');
      INSERT INTO canvases (id, title, created_by) VALUES ('canvas-1', 'Launch', 'user-1');
      INSERT INTO canvas_nodes (id, canvas_id, content, x, y, created_by) VALUES ('node-1', 'canvas-1', 'Start', 10, 20, 'user-1');
      INSERT INTO canvas_nodes (id, canvas_id, content, x, y, created_by) VALUES ('node-2', 'canvas-1', 'Ship', 300, 20, 'user-1');
      INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, created_by) VALUES ('edge-1', 'canvas-1', 'node-1', 'node-2', 'user-1');
    `)

    expect(sqlite.prepare('SELECT title, content, version FROM documents WHERE id = ?').get('doc-1')).toEqual({ title: 'Plan', content: '<p>Hello</p>', version: 1 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM canvas_nodes WHERE canvas_id = ?').get('canvas-1')).toEqual({ count: 2 })
    expect(sqlite.prepare('SELECT from_node_id, to_node_id FROM canvas_edges WHERE id = ?').get('edge-1')).toEqual({ from_node_id: 'node-1', to_node_id: 'node-2' })
    expect(() => sqlite.exec("INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, created_by) VALUES ('edge-self', 'canvas-1', 'node-1', 'node-1', 'user-1')")).toThrow()
    sqlite.exec("DELETE FROM canvas_nodes WHERE id = 'node-1'")
    expect(sqlite.prepare('SELECT count(*) AS count FROM canvas_edges').get()).toEqual({ count: 0 })
    const resources = await loadDataResources({
      DB: {
        prepare(sql: string) {
          return { async all() { return { results: sqlite.prepare(sql).all() } } }
        },
      },
    } as never)
    expect(resources.databases).toEqual([{
      id: 'db-1', name: 'Archive', archivedAt: expect.any(String), itemCount: 1,
      views: [{ id: 'default:db-1', databaseId: 'db-1', name: 'All records', layout: 'table', position: 1024 }],
    }])
    expect(resources.bookmarks).toEqual([])
    expect(resources.documents[0]).not.toHaveProperty('content')
    expect(resources.canvases[0]).not.toHaveProperty('nodes')
    expect(resources.canvases[0]?.nodeCount).toBe(1)
    sqlite.close()
  })
})
