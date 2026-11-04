---
title: Data
description: Keep pages, database records and canvases together, with nested pages and properties.
order: 7
---

**Data** in the rail holds a Server's shared knowledge: pages, Databases and Canvases. A page, a database record and a Canvas each have one identity: an **Item**. Everything stays inside one Server and its Space. Tasks keep their own workflow.

## Databases

A Database gives its records a shared set of properties. Create one with **New database**, then add fields with **+** in the header. Every record has a **Title**, and can also have formatted content and pages inside it.

| Field | Holds |
| --- | --- |
| **Text**, **Number**, **Checkbox**, **Date** | A line of text, an amount, done or not, one day |
| **Select**, **Multi-select** | One option, or any number of options, from the field's list |
| **URL**, **Email**, **Phone** | An address you can open, write to or call from the record |
| **Person** | Members of this Server |
| **Relation** | Records of a Database, this one included; a link opens the record |

- Type in the last row to add a record, or use **Record**.
- Click a cell to edit it. **Open** on a row, or a card in any other view, opens its property panel. Choose **Open page** to edit the same Item's content and child pages.
- **Filter**, **Sort** and **Properties** above the table change the current view as you set them. Saved views keep their own filters, sort and shown fields; **View settings** has them all in one place.
- Views come as a **Table**, **Board** grouped by a Select field, **Calendar** on a Date field, **List** or **Gallery** of cards.
- **Search** filters the current view.
- Archive a Database you no longer use. **Archived databases** lists them for restoring.

## Pages

Create a page with **New page**; its title and formatted text save as you type. **Icon & cover** changes its appearance, **Page history** shows previous text versions, and **Add page** creates a page inside it. The sidebar shows nested pages. Navigation saves your draft first; an unsaved draft is protected when you close or reload the browser tab.

Use **Move** to choose a parent page or a Database. These are independent: an Item can be nested without belonging to a Database, and can belong to at most one Database. Its address, content, child pages, history, bookmarks and ordinary links stay with it when it moves.

Leaving a Database or choosing another one requires confirmation to remove the old property values and incoming/outgoing Relation links. Moving a page never grants access to it: readers must have access to its parent pages and its Database too.

Deleting a page moves it and its subtree out of view into **Trash**. Restore it from Data's Trash. A page whose parent or Database is still in Trash cannot be restored on its own.

## Canvases

A Canvas is an Item with a board of notes and text you can arrange and connect. Add cards with **Note** or **Text**, drag them into place and link two of them with **Connect**. It also has page notes, child pages, and the same **Move** control; its board stays with it when it joins a Database.

## Who can do what

Three Role permissions cover Data:

| Permission | Allows |
| --- | --- |
| **Read data** | Read authorized Databases, Items and Canvases |
| **Write data** | Create and edit pages and records |
| **Manage data** | Manage Databases, fields, Canvas structure, Item locations and Trash |

## Agents and MCP

An Agent whose Role and the person who asks both allow it can find tables with `list_tables`, read records with `read_records`, and edit properties with `create_record` and `update_record`. Multi-select, Person and Relation values are lists; `read_records` returns the titles of linked records alongside their IDs.

`list_items`, `get_item`, `create_item` and `update_item` work with page content, including Items in Databases. `move_item` changes their parent or Database, with explicit confirmation before removing old properties. An Agent's Role can be limited to chosen Databases, pages and Canvases; nesting does not bypass those limits.

MCP clients use the `data:read`, `data:write`, `data:manage`, `documents:read` and `documents:write` scopes. See [MCP](../agents/mcp.md).
