---
title: Schedules
description: Set one-time, daily or weekly reminders and recurring Agent work in L4, and recover a Schedule that is paused or blocked.
order: 6
---

A Schedule triggers a reminder or Agent work at a time you choose, once, daily or weekly. It runs under the permissions you had when you saved it, and those permissions are checked again before every occurrence.

## Who can use Schedules

Schedules need **Manage schedules** in your Role. No Role has it by default, not even Admin. When you have it, **Schedule** appears in the rail.

Recurring Agent work additionally needs **Execute assigned tasks** and **Use agents** for you, and **Execute assigned tasks** for the Agent. Repository work also needs **Use a computer** for both.

## Kinds of Schedule

- **Reminder** posts `Reminder: …` to the chosen conversation as you, at most 1,800 characters. It stays unread for you and sends you a push notification, so it reminds you even though you wrote it.
- **Run an assigned task** starts an Agent Run on a Task assigned to that Agent. It needs Agent execution configured on the Server and an active Agent. It stops by itself once the Task is done or archived.

## Create a Schedule

1. Select **Schedule** in the rail.
2. In **What should happen?**, write the reminder text or the instruction for the Agent.
3. Choose the **Action**: **Reminder** or **Run an assigned task**.
4. Choose the **Conversation**. For a task, also choose the **Assigned task**.
5. Enter the **First time** and choose the **Timezone**. The form previews the time in that zone and in yours.
6. Choose **Repeat**: **Once**, **Daily** or **Weekly**.
7. Select **Schedule**.

![The Schedules page with the new schedule form showing What should happen?, Action, Conversation, First time, Repeat and Timezone, and the Schedule button](screenshot:agents-schedules-form "Create a Schedule")

The first time must be between five seconds and 366 days ahead. Daily and weekly repetitions keep the same wall-clock time across daylight saving changes. A time that falls in a daylight saving gap moves to the first valid time, and a repeated hour uses its first occurrence; the form warns about both.

You can have 50 active Schedules, paused ones included. The form shows how many you use, for example `3 of 50 active`.

## Manage Schedules

The list has **Current**, **Active**, **Paused**, **Blocked** and **History** filters. For each Schedule you can:

- **Pause** it, and **Resume** it later. Missed repetitions are skipped, never replayed. A one-time Schedule whose time has passed runs at once when resumed.
- **Edit** its text, next time, repeat or timezone, and for task work its Task. The action and conversation cannot change; cancel it and create a new one instead. Only the person who created a Schedule can edit it.
- **Cancel** it.
- **Remove** a completed or cancelled Schedule from your list.
- Open **History** to see recent occurrences with links to the delivered message or started Run.

Editing saves your current permissions as the Schedule's new ceiling. It never brings back a permission removed since you created it. While an occurrence is being delivered, you cannot change the time of an active Schedule; pause it first or wait until it finishes.

## When a Schedule fails or is blocked

A temporary failure, such as a rate limit or the daily Run budget, is shown on the Schedule and retried after 30 seconds, 1 minute, 5 minutes, 15 minutes and 1 hour. After the last retry, the occurrence counts as missed: a repeating Schedule moves on to its next time, and a one-time Schedule becomes **blocked**.

A Schedule is **blocked** at once when something it relies on is gone. The list shows the reason and a hint:

| Reason | Cause | What to do |
| --- | --- | --- |
| `schedule_revoked` | A Role, resource grant or Member was reduced or removed. | Restore it, then **Resume**. |
| `channel_unavailable` | The conversation was removed or no longer accepts your messages. | Restore access, then **Resume**, or create a new Schedule. |
| `task_reassigned` | The Task was assigned to someone else. | Assign it back, then **Resume**. |
| `agent_unavailable` | The Agent is paused or removed. | Activate it, then **Resume**. |
| `pi_unconfigured` | Agent execution is not configured on the Server. | Ask the Server operator, then **Resume**. |
| `code_denied`, `code_revoked` | The repository environment changed or computer permission was removed. | Create a new Schedule after reviewing it. |

**Resume** checks again first, so it fails with the same reason until the cause is fixed. Editing a blocked Schedule makes it active again once the edit passes the same checks.

Archiving a channel blocks Schedules that post there until the channel is restored. You can always cancel a Schedule, even after losing access to its conversation; it is then listed as "Conversation unavailable".

## Schedules created by Agents

During a Run in a conversation, an Agent with **Manage schedules** can create, edit, list and cancel reminders in that conversation for you. Agents check the current Server time first and should confirm ambiguous times with you. A reminder an Agent created is the Agent's to edit.

## API

Schedules also have an HTTP API under `/api/schedules` for signed-in Members with **Manage schedules**. See [docs/schedules.md](https://github.com/inchidev/llll/blob/main/docs/schedules.md#api).

## Related

- [Agents overview](overview.md)
- [Notifications](../guides/notifications.md)
