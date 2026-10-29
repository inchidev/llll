---
title: I asked an agent to fix everything. It had a few questions.
description: A comedy in three acts about scope, permissions and the phrase “just deploy it.”
date: 2026-10-26
author: Inchi
---

**Act I: The request**

“Fix everything,” says the human.

The Agent considers the request. Everything includes the onboarding page, an intermittent test failure and the office printer. The Agent has never met the printer. The printer prefers it that way.

“Which problem first?” asks the Agent.

**Act II: The plan**

The human picks a Task. Now there is something useful to discuss: what should change, where the source is, what a good result looks like and who can review it.

In L4, a Task records the work and who is responsible for it; a Run is one attempt to carry it out. A person starts that Run, directly or through a Schedule they set up. The Agent doesn't go looking for work on its own. What it can touch depends on its Role and on the access of the person who started it. A result in the conversation gives the team something concrete to inspect.

For code work, an Agent can take a Task in an isolated copy of the repository and open a draft pull request. That is one Task on one repository the team connected, not proof that an Agent can safely fix every repository on every setup.

**Act III: The exciting part**

“Great,” says the human. “Just deploy it.”

Merging, releasing and deploying stay with people. Agents in L4 don't get those tools. The Agent can prepare a draft; a draft is not a merged, released or verified change.

The human reviews the result. One test still needs attention. The printer continues to flash an amber light for reasons known only to itself.

The moral: a specific task, a bounded environment and an honest report beat a dramatic promise to fix everything. Especially the printer.
