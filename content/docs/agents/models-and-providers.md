---
title: Models and Providers
description: Connect OpenRouter, Claude, ChatGPT or Workers AI to your L4 Server, choose a default model and assign models to AI functions.
order: 2
---

Agents need a model to reply. You connect model **Providers** in **Server settings → Models**. API keys are stored on your Server, encrypted with its `AUTH_SECRET`, and are never shown to Members or sent to the browser.

The Owner manages Server Providers and defaults. Members with **Use agents** see the same page but can only connect their own ChatGPT plan; they see which models are available, never the credentials.

## Supported Providers

| Provider | How it connects | Who can add it |
| --- | --- | --- |
| OpenRouter | API key. Hundreds of models with one key. | Owner |
| Claude | Anthropic API key. | Owner |
| ChatGPT / Codex | **Continue with ChatGPT** sign-in with your ChatGPT plan. | Owner, or any Member with **Use agents** for their own plan |
| Workers AI | Comes with a Cloudflare Server's deployment, billed to its Cloudflare account. | Listed automatically; the Owner can turn it off |

Claude Pro or Max subscriptions cannot be used: the Claude Provider needs an Anthropic API key.

## Add an API key Provider

1. Open **Server settings → Models**. The Owner sees the **Providers** and **Defaults** tabs.
2. Select **Add provider** and choose **OpenRouter** or **Claude**.
3. Optionally change the **Connection name**, for example to tell a work account from a personal one. You can add several connections of the same Provider.
4. Paste the **API key**.
5. In **Models**, use **Add a model…** to pick models from the Provider's catalog. Each model shows what it accepts (text, images, audio, video, files) and whether it reasons.
6. Keep **Available to agents** on and select **Save**.

![The Add provider form in Server settings → Models with the OpenRouter, Claude and ChatGPT / Codex cards, the API key field and the Models picker](screenshot:agents-add-provider "Add a model Provider")

To change a key later, open the connection and paste a new one. Leaving **API key** empty keeps the saved key. **Remove connection** deletes it.

Models listed for a connection appear in Agent and conversation model pickers. Models without tool support are offered to AI functions only.

> [!TIP]
> Models chosen before L4 recorded model capabilities may show none. Open the Provider and select **Save** once to refresh them.

### Context window and answer limit

Each chosen model shows the context window and answer limit an Agent's Run will use, and where each comes from: **reported by the provider**, **set by you**, **from Pi's catalog** or **default** (128,000 and 8,192 tokens). A Run uses at most 200,000 tokens of window and 32,000 for an answer, and at most a quarter of the window for an answer.

When the provider did not report a limit, for example for a private model, select **Set limits** beside it and enter the window or answer limit in tokens, then **Save**. What a provider reported is always used as reported. The model that comes with the deployment, an OpenAI-compatible endpoint set by the operator, has the same **Set limits** under its entry at the top of the list; those figures apply only while the deployment uses that model.

### Exa web search

An Exa key is the other way to search. Enter it in **Server settings → Integrations → Web search**. It takes precedence over OpenRouter.

### OpenRouter web search

An OpenRouter connection has a **Web search** switch. It lets Agents with **Research the web** search through OpenRouter. Additional OpenRouter charges apply. To use it, also assign a model to the **Web search** AI function (see below).

## Connect ChatGPT

ChatGPT uses your ChatGPT plan instead of an API key.

1. In **Server settings → Models**, select **Add provider** (Owner) or **Connect ChatGPT** (Members), and choose **ChatGPT / Codex**.
2. Select **Continue with ChatGPT** and approve in the ChatGPT tab that opens.
3. ChatGPT then opens a page at an address starting with `http://127.0.0.1:1455` that cannot load. That is expected: OpenAI returns the sign-in only to your own computer. Copy that page's full address.
4. Paste it into L4 and select **Finish connecting**. The address works once and expires in 10 minutes.

When L4 runs on your own computer at `localhost` or `127.0.0.1`, the sign-in finishes on its own and you do not need to paste anything.

By default, a ChatGPT connection serves only the person who connected it. To let others use it, the person who connected it turns on **Share with everyone on this Server**. Every Member's Agents and AI functions can then use that plan, and their requests count against its limits. Only the person who connected it can change this.

Connecting ChatGPT does not sign anyone in to L4 or grant membership. Removing the connection stops its use in L4 and tries to revoke the sign-in. If L4 says remote revocation was not confirmed, disconnect L4 in your ChatGPT settings.

## Workers AI

On a Cloudflare Server, Workers AI appears at the top of the Providers list as **Included with this Server**. It cannot be removed here. Open it to turn **Available to agents** off or choose which models appear in model pickers.

## Choose a default model

Connecting a Provider never selects a default. Without a default, each Agent needs its own model.

1. Open **Server settings → Models → Defaults**.
2. Under **Model defaults**, choose a **Default model**, or **No default model**.

An Agent's own model overrides the default, and a conversation's model picker overrides both. If a chosen model is disabled or unavailable, Runs fail with an explanation; L4 never silently switches to another model.

## AI functions

AI functions are small Server jobs that use a model directly, without an Agent. Assign them in **Server settings → Models → Defaults → AI functions**. All start **Disabled**, and none inherits the default model.

| Function | What it does |
| --- | --- |
| Help with Apps | Drafts Apps from Database Views. Apps are paused in this release. |
| Thread titles | Names new Threads from their first message. Existing titles stay. |
| Web search | Search for Agents. Choose an OpenRouter model with web search enabled. An Exa key under **Server settings → Integrations** takes precedence. |
| Images | Draws pictures an Agent asks for while it works in a Task's box, such as the art of a game, and saves each as a file in its checkout. Needs an OpenRouter model that outputs images. Without one, Agents use the Avatars model. |
| Avatars | Draws profile pictures for Members and Agents. Needs an OpenRouter model that outputs images, such as Nano Banana. |
| Image descriptions | Describes attached images for Agents whose model cannot see them. |
| Voice transcription | Turns voice messages into text for Agents. |

Each function lists only models that can do the job. Descriptions and transcripts reach the Agent marked as untrusted data. AI function calls are limited to 20 per Member per minute.

Personal ChatGPT connections that are not shared serve only their owner's requests; other Members see them as unavailable.

### Generate avatars

With **Avatars** assigned, profile and Agent settings show **Generate**. Describe the picture, optionally add up to three reference images, and keep **L4 style** for a toy-like black-and-white character shaped after the L4 logo. Preview it, then select **Use this picture**.

## Images and voice

When a message has images attached, the Agent receives the sender's own images from that conversation if its model accepts images. If it does not, the **Image descriptions** function supplies a description instead; without either, the Agent says it cannot view them. Voice messages reach Agents as text through **Voice transcription**.

## Related

- [Agents overview](overview.md)
- [Create your first Agent](../get-started/first-agent.md)
- [Costs and limits on Cloudflare](../cloudflare/costs-and-limits.md)
