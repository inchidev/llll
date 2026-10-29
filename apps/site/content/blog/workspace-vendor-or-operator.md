---
title: Your workspace stack has a landlord problem
description: Slack, Notion and hosted tools make work convenient. They also make their operators' decisions part of your operating model.
date: 2026-10-30
author: Inchi
---

Your team chat is in Slack. Your documents are in Notion. Your task tracker is somewhere else. Each product is convenient on its own. Together, they mean your work depends on several vendors, several accounts, several permission models and whatever each provider decides to change next.

This is not a conspiracy. Hosted services cost money to run, and vendors set terms for their products. [Slack's free plan shows the last 90 days of messages and files](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces); [Notion provides exports](https://www.notion.com/en-gb/help/export-your-content) but its database export does not include every view at once. Those are concrete product choices. The larger problem is treating those choices as if they were invisible infrastructure.

## A different default

L4 is MIT-licensed software for running an independent Server. The Server keeps its Accounts, permissions and content local to that community. The Shell is a convenient way to navigate between Servers, not a global membership authority. Operators run it on their own Cloudflare account or self-host it on a VPS, and keep backups separate from live data.

That changes who has work to do. Your operator needs infrastructure, a secure setup, updates and a recovery plan. Providers can still change their prices or suffer outages. Open source does not abolish dependencies; it gives you more control over which ones you accept and how you respond.

## Don't move on slogans

The mature products in your stack may offer capabilities L4 does not. There is no promise of an automatic import from Slack or Notion, full feature parity, or zero-cost hosting. Before moving real work, list the workflows you actually use, test permissions with two people, verify files and recovery, and keep your existing data until you have a plan.

We are building toward a workspace that is easier to operate without giving up the community's authority over it. Judge that claim by the install, the everyday workflow and the restore—not by the size of the “open source” label.

*Slack and Notion details checked October 29, 2026 ([Slack: Usage limits for free workspaces](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces), [Notion: Export your content](https://www.notion.com/en-gb/help/export-your-content)).*
