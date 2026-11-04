# Data Items

Data has one content identity: an Item. A page, a database row, and the owner of a Canvas all use `data_items`. Tasks retain their own model and lifecycle.

An Item belongs to one Space and has a stable ID, title, HTML content, optional icon, position and optimistic version. Its immutable kind is `page` or `canvas`; Canvas nodes and edges keep their specialized tables and reference that Item. Duplicate page titles are allowed.

`parent_id` expresses nesting. `database_id` is optional and identifies at most one Database supplying typed properties. The two relationships are independent. A Database retains its fields, typed slots, relation links and saved Views. Moving into a Database retains identity, body, children, revision history, bookmarks and ordinary references. Moving out or to another Database requires explicit confirmation to discard old custom values and incoming/outgoing property relations. These changes are atomic and version checked. An Item cannot cross Spaces, become its own ancestor or change kind.

Read access requires access to the Item's current Database (for a database member) or its page/Canvas resource, and every parent. This applies before list counts, pagination, search and linked-title disclosure. Nesting never grants access. Trash on an ancestor or Database hides the subtree. Restoring an Item requires a live parent and Database; permanently deleting a subtree checks all descendants and deletes children first. Permanent purge remains limited to human sessions.

The public content route is `/items/:id`. Items API handles metadata, content, nesting, membership, history and deletion. `/api/items/:id/properties` handles typed values and `/api/items/:id/canvas`, `/nodes` and `/edges` handle Canvas structure. The former document, canvas and database-item API routes and page URLs are removed; there is no compatibility fallback. Agent and MCP tools use get/create/update/move/list Item operations. References and bookmarks use the stable `item` identity; Tasks are still referenced as `task`.

The published baseline remains immutable. Migration 0001 builds the unified table, copies existing content and relationships, changes foreign keys, and removes the three old tables. It supports both a fresh Server and the published baseline. It is the one unpublished migration for this change and must be combined with other unreleased schema work before release.

This change does not introduce collaborative CRDT editing, arbitrary multi-database membership, formulas, rollups, a block engine, or Task-to-Item conversion.
