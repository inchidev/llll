# Schedules

A Schedule triggers a reminder or work under a saved, revocable authorization. Manage yours at `/schedules`.

## Permissions

`manageSchedules` is a separate opt-in permission. No role receives it automatically, including administrators; grant it in Server settings → Roles. Recurring work also needs `executeTasks` and `useAgents` for you, and `executeTasks` for the assigned Agent. Repository work also needs `useComputer` for both.

A Schedule saves the role and resource ceiling of the person (or delegated Agent) who created it. Every occurrence reloads current grants and conversation access; it never runs with more than the saved ceiling, and a reduction blocks it.

## Kinds

- **Reminder**: posts `Reminder: …` to the chosen conversation as you. It stays unread for you and sends you a push notification, so it reminds you even though you are its author. At most 1800 characters.
- **Recurring work**: starts an Agent Run on a Task assigned to that Agent. It needs agent execution configured on the Server and an active Agent; otherwise creation fails with `pi_unconfigured` or `agent_unavailable`. Work stops (status `completed`, reason `task_closed`) once the Task is done or archived.

## Time

The first time must be between five seconds and 366 days ahead. Choose a timezone from the IANA list; the form previews the resolved time in that zone and in yours. Daily and weekly repetitions keep the original wall time across DST changes. A wall time inside a DST gap moves forward to the first valid time; one repeated by an overlap uses its first occurrence; the form warns about both. Missed repetitions (for example after a pause) are skipped, never replayed.

## Editing

Edit opens the form with the Schedule's content, next time (in its timezone), repetition and timezone; for recurring work also its Task. The action and conversation cannot change; cancel and create a new Schedule instead. Only its creator can edit an active, paused or blocked Schedule. A reminder an Agent created is the Agent's to edit.

An edit is authorized like a new Schedule: the same permission, conversation, Agent, Task, repository and limit checks run with your current grants, and the saved role and resource ceiling (and a work mandate) is replaced with them. An edit never restores a permission removed since creation, and never allows more than creating the Schedule would.

- Changing the time, timezone or repetition makes the new time the next run, subject to the same five seconds to 366 days window and DST rules. Changing only the timezone keeps the instant and repeats at its wall time in the new zone.
- Changing only the content or Task keeps the next run, so an occurrence being delivered is delivered once and the change applies from the next one.
- The time of an active Schedule cannot change while its current occurrence is due (being delivered or awaiting a retry); `409 schedule_due`. Pause it first, or edit after it finishes.
- A paused Schedule stays paused. A blocked one becomes active. Occurrence history is kept.

## Limits

Each person may have 50 active Schedules (paused ones count). The list shows `N of 50 active`.

## Status and recovery

| Status | Meaning |
| --- | --- |
| `active` | Waiting for its next run. |
| `paused` | Kept with its due time, not run. Resume skips missed repetitions; a one-time Schedule whose time passed runs at once. |
| `blocked` | Stopped until a person acts. The list shows the reason and a recovery hint. |
| `completed` | No further occurrences. |
| `cancelled` | Stopped by its owner. |

A transient failure (rate limit, daily run budget, an unavailable service) is shown on the Schedule and retried after 30 s, 1 min, 5 min, 15 min and 1 h, never into the next repetition. After the last retry the occurrence is recorded as missed: a repeating Schedule advances, a one-time Schedule becomes `blocked`.

A Schedule is blocked immediately when a permission or resource it relies on is gone. Common reasons:

| Code | Cause | Recovery |
| --- | --- | --- |
| `schedule_revoked` | A role, resource grant or Member was reduced or removed. | Restore it, then Resume. |
| `channel_unavailable` | The conversation was removed or no longer accepts messages from you. | Restore access, then Resume, or create a new Schedule. |
| `task_reassigned` | The Task was assigned to someone else. | Assign it back, then Resume. |
| `agent_unavailable` | The Agent is paused or removed. | Activate it, then Resume. |
| `pi_unconfigured` | Agent execution is not configured. | Ask the Server operator, then Resume. |
| `code_denied` / `code_revoked` | The repository environment changed or computer permission was removed. | Create a new Schedule after reviewing it. |

Resume re-runs the delivery checks first, so it fails with the same reason until the cause is fixed. Editing a blocked Schedule makes it active again once the edit passes the same checks; otherwise the edit is refused with the reason and the Schedule stays blocked. You can Cancel a Schedule even after losing access to its conversation; such Schedules are listed as "Conversation unavailable" without their content. Remove hides a completed or cancelled Schedule from your list.

History shows the last occurrences with links to the delivered message or the started Run. Each Schedule keeps its latest 100 finished occurrences.

## API

All routes need a signed-in Member with `manageSchedules`. Errors use `{ error: { code, message } }`.

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /api/schedules` | `status` = `current` (default: active, paused, blocked), `history` (completed, cancelled), or one status; `cursor`; `limit` ≤ 100 | `{ schedules, nextCursor, activeCount, activeLimit, workAvailable }`. Current lists blocked first, then by next run; history newest first. |
| `POST /api/schedules` | `{ channelId, kind: 'reminder' \| 'work', content, firstAt (ISO with offset), timezone (IANA), recurrence: 'once' \| 'daily' \| 'weekly', agentId?, taskId? }` | `{ schedule }`; `429 schedule_limit` at the active limit. |
| `PATCH /api/schedules/:id` | `{ action: 'pause' \| 'resume' \| 'dismiss' }` | `{ schedule }` (pause/resume) or `{ ok }`; `409 schedule_inactive` when the status does not allow it. |
| `PATCH /api/schedules/:id` | `{ action: 'edit', content?, firstAt?, timezone?, recurrence?, agentId?, taskId? }`; at least one field; omitted fields keep their value; `agentId`/`taskId` for work only | `{ schedule }`; `403 schedule_denied` for anyone but the creator, `409 schedule_inactive` once finished, `409 schedule_due`, `400 schedule_time`, `429 schedule_limit`, or the creation check that failed. |
| `DELETE /api/schedules/:id` | | Cancels an active, paused or blocked Schedule; `409 schedule_inactive` once finished. |
| `GET /api/schedules/:id/occurrences` | | `{ occurrences: [{ dueAt, completedAt, failedAt, attempts, lastError, messageId, runId }] }`, newest first. |

A Schedule's `lastError` and `lastErrorCode` hold the latest failure. `unavailable: true` marks one whose conversation you can no longer open.

## Agent tools

Within a Run in a conversation, an Agent with `manageSchedules` (subject to tool review) can use:

- `create_reminder` `{ content, firstAt, timezone, recurrence }`: a reminder in the Run's conversation. Confirm ambiguous times with the person first; `get_current_time` gives the Server time and timezone.
- `update_reminder` `{ scheduleId, content?, firstAt?, timezone?, recurrence? }`: edit a reminder the Agent created in the Run's conversation, under the same rules as an edit.
- `list_schedules` `{ status?, cursor? }`: the same page as `GET /api/schedules`.
- `cancel_schedule` `{ scheduleId }`.
