---
title: Data
description: Keep Databases, Documents and Canvases in an L4 Server, and let Agents and MCP clients read and update them.
order: 7
---

**Data** in the rail holds a Server's shared knowledge: Databases of records, Documents and Canvases. Everything stays inside one Server.

## Databases

A Database is a table of records. Create one with **New database**, then add fields with **+** in the header: **Text**, **Number**, **Checkbox**, **Date** or **Select**. Every record has a **Title**.

- Type in the last row to add a record, or use **Record**.
- Double-click a cell to edit it.
- **Search** filters the current view. Saved views keep their own filters and sort.
- Archive a Database you no longer use. **Archived databases** lists them for restoring.

## Documents

A Document is a page of formatted text. Create one with **New document**; it saves as you type. If you leave the page right after typing, the browser asks before discarding the last change.

## Canvases

A Canvas is a board of notes and text you can arrange and connect. Add items with **Note** or **Text**, drag them into place and link two of them with **Connect**.

## Who can do what

Three Role permissions cover Data:

| Permission | Allows |
| --- | --- |
| **Read data** | Read authorized tables, records and documents |
| **Write data** | Create and edit records and documents |
| **Manage data** | Create Databases, Documents, Canvases and fields |

## Agents and MCP

An Agent whose Role and the person who asks both allow it can find tables with `list_tables`, read records with `read_records`, add and change them with `create_record` and `update_record`, and read or write Documents. An Agent's Role can also be limited to chosen Databases and Documents.

MCP clients use the `data:read`, `data:write`, `data:manage`, `documents:read` and `documents:write` scopes. See [MCP](../agents/mcp.md).
