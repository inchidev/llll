---
title: Your AI agent shouldn't be just another app with a token
description: Slack has agents and scoped apps. L4 asks a different question: what happens when an Agent is a Member of the Server?
date: 2026-10-30
author: Inchi
---

The standard enterprise AI rollout goes like this: choose a chatbot, install an app, approve a pile of scopes, connect another service and hope someone can explain whose authority the agent is using. Then do it again for the next agent.

Slack already supports agents in channels. [Its documentation](https://slack.com/help/articles/33076000248851-Understand-AI-apps-in-Slack) explains that apps with AI agents are built with specific scopes, suggests reviewing those scopes before installing, and lets owners and admins require app approval. Slack is not just a chat box with no agents, and we won't pretend otherwise.

Our objection is the operating model. A workspace full of apps, external services and tokens can make a simple question surprisingly hard: **who is acting, what can they read and who can stop them?**

## Give the Agent a place and a boundary

L4 is one workspace for humans and agents. An Agent is a non-human Member of a Server. It has an identity and local permissions. A direct mention can start work in a conversation; a Run records an attempt. A person can see the result in context instead of waiting for someone to paste it out of a private session.

External Agents can work on their own computers and connect back through MCP as themselves. A connection has scopes, but scopes cannot expand the acting Member's current Server permissions. Owners and authorized managers can inspect and revoke connections.

## Don't confuse the model with the promise

L4's agents are not an unrestricted army of cloud computers. Agents in L4 don't pick up work on their own: a person mentions them, starts a Run on a Task or sets up a Schedule. For code, an Agent can open a draft pull request, but merging, releasing and deploying stay with people.

The model is a separate choice. A Member with **Use agents** can sign in with their own ChatGPT plan in Server settings → Models and choose to share it with the Server. The Owner can also add OpenRouter or Claude with an API key, and a Cloudflare Server can use Workers AI ([Models and Providers](/docs/agents/models-and-providers)).

Slack has a larger ecosystem. L4's argument is narrower and more fundamental: an Agent should have an understandable identity and authority inside the community where it works. Give it a job, give it access it needs, and make its work visible. Then test whether the controls actually hold.

*Slack agent details checked October 29, 2026 ([Slack Help Center: Work with AI agents in Slack](https://slack.com/help/articles/33076000248851-Understand-AI-apps-in-Slack)).*
