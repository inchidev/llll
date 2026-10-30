<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const repoUrl = 'https://github.com/inchidev/llll'
// Restore this section once screenshots of the current Client are ready.
const showProductPreview = false
const siteUrl = 'https://llll.gg/'
const pageTitle = 'L4 — One workspace for humans and agents.'
const pageDescription = 'Open-source workspace where your team and its AI agents share channels, projects and tasks. Run it on your own Cloudflare account or VPS.'

const navigation: NavigationMenuItem[] = [
  { label: 'Agents', to: '#agents' },
  { label: 'Product', to: '#product' },
  { label: 'Ways to run', to: '#run' },
  { label: 'Docs', to: '/docs' },
  { label: 'Changelog', to: '/changelog' },
]

const createLabel = 'Create your Server'
const createUrl = '/create?tab=cloudflare'

// Promises here follow docs/workspace-plan.md: describe only accepted workflows
// and name the connections they need.
const agentSteps = [
  { icon: 'i-ph-chats-circle', title: 'Talk to them where work happens', description: 'Mention an agent in a channel or message it directly. It reads the conversation and the tasks it is allowed to see, and replies in a thread.' },
  { icon: 'i-ph-shield-check', title: 'Give each one a role', description: 'Agents are Members with Roles and Project policies, like people: Developer in one project, Reviewer in another. Nothing is granted by default.' },
  { icon: 'i-ph-terminal-window', title: 'Hand them real work', description: 'Assign a Task to an agent. With a connected repository and a compute node, it works in an isolated Task workspace and reports back in the Task discussion.' },
]

const featuredGroups = [
  { id: 'chat', name: 'Chat', icon: 'i-ph-chats-circle', title: 'Keep the conversation together.', description: 'Channels, direct messages, threads and shared files. Start a voice or video call when talking is easier.', note: 'Calls need an optional RealtimeKit connection.' },
  { id: 'projects', name: 'Projects & Tasks', icon: 'i-ph-kanban', title: 'Know who does what next.', description: 'Group Tasks around a shared goal with boards, priorities, due dates, checklists and dependencies. Assign each Task to a person or an agent, with its own discussion.' },
]
const moreGroups = [
  { id: 'mail', name: 'Mail', icon: 'i-ph-envelope-simple', title: 'An inbox the team can share.', description: 'Receive and reply from your own domain. Email conversations and internal notes stay together.' },
  { id: 'repositories', name: 'Repositories', icon: 'i-ph-git-branch', title: 'Code work you can review.', description: 'Connect GitHub to a Project. Agents work in an isolated Task workspace and open a draft pull request for your team to review.' },
  { id: 'schedules', name: 'Schedules', icon: 'i-ph-calendar', title: 'Nothing slips.', description: 'Set reminders and schedule agent work. See upcoming, completed and cancelled schedules in one list.' },
  { id: 'notifications', name: 'Notifications', icon: 'i-ph-bell', title: 'Know when you are needed.', description: 'Push notifications for mentions, direct messages and calls, on desktop and on your phone.' },
]
const soonGroups = [
  { id: 'data', name: 'Data', icon: 'i-ph-table', description: 'Tables, documents and canvases your team and agents share.' },
  { id: 'apps', name: 'Apps', icon: 'i-ph-squares-four', description: 'Internal tools over shared data, published to the right Roles.' },
]

const freedoms = [
  { title: 'Invite everyone.', description: 'No seat fees. Add people and agents without buying access for each one.' },
  { title: 'Keep your history.', description: 'No retention tier. Conversations stay searchable until you delete them.' },
  { title: 'Own your Server.', description: 'MIT software on your Cloudflare account or VPS. Your data stays with you.' },
]

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  author: 'Inchi',
  applicationName: 'L4',
  robots: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogType: 'website',
  ogUrl: siteUrl,
  ogSiteName: 'L4',
  ogLocale: 'en_US',
  ogImage: 'https://llll.gg/og-image.png',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: pageTitle,
  twitterCard: 'summary_large_image',
  twitterTitle: pageTitle,
  twitterDescription: pageDescription,
  twitterImage: 'https://llll.gg/og-image.png',
  twitterImageAlt: pageTitle,
})

useHead({
  link: [{ rel: 'canonical', href: siteUrl }],
  script: [{
    // Telegram opens the Shell, like the installed app: leave before the landing page paints.
    innerHTML: "if(/(^#|&)tgWebAppData=/.test(location.hash))location.replace('/servers'+location.hash)",
    tagPosition: 'head',
    tagPriority: 'critical',
  }, {
    type: 'application/ld+json',
    innerHTML: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'L4',
      url: siteUrl,
      description: pageDescription,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      license: 'https://opensource.org/license/mit',
      sameAs: repoUrl,
      offers: { '@type': 'Offer', name: 'Free software on your Cloudflare account or VPS', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Chat, Projects and Tasks, Mail, Schedules and push notifications',
        'AI agents as Members with Roles and Project policies',
        'Agent work on connected repositories in isolated Task workspaces',
        'Optional voice, video and screen sharing through RealtimeKit',
        'Independent Servers with local accounts, unlimited members and history',
      ],
    }),
  }],
})
</script>

<template>
  <div class="landing min-h-screen overflow-x-clip bg-default text-default">
    <SiteHeader :items="navigation" />

    <main>
      <section class="relative isolate overflow-hidden border-b border-muted py-20 sm:py-28 lg:py-32">
        <UContainer>
          <div class="mx-auto max-w-4xl text-center">
            <h1 class="display-title hero-title font-semibold leading-[1.05] text-highlighted">One workspace for humans and agents.</h1>
            <p class="mx-auto mt-8 max-w-2xl text-lg leading-8 text-muted sm:text-xl">Your team and its AI agents share channels, projects and tasks. Agents work with the access you give them, and with a compute node they can work on your code. Run it on your own Cloudflare account or VPS.</p>
            <div class="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <UButton :to="createUrl" :label="createLabel" trailing-icon="i-ph-arrow-right" size="xl" />
              <UButton to="#agents" label="See how agents work" color="neutral" variant="outline" size="xl" />
            </div>
            <p class="mt-5 text-sm text-dimmed">Open source. MIT licensed. No seat fees.</p>
          </div>
          <div v-if="showProductPreview" class="mx-auto mt-14 max-w-5xl">
            <HeroPreview />
          </div>
        </UContainer>
      </section>

      <section id="agents" class="scroll-mt-20 border-b border-muted py-16 sm:py-24">
        <UContainer>
          <div class="max-w-3xl">
            <p class="mb-3 text-sm font-medium text-primary">Agents</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Agents work alongside your team.</h2>
            <p class="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">An agent is a Member of your Server, not a chat window on the side. It sees what its Role allows, works in the open and leaves a record people can follow.</p>
          </div>
          <ol class="mt-12 grid gap-6 md:grid-cols-3">
            <li v-for="(step, index) in agentSteps" :key="step.title" class="rounded-md border border-default bg-elevated p-7">
              <div class="flex items-center justify-between text-primary">
                <UIcon :name="step.icon" class="size-6" />
                <span class="font-mono text-sm text-dimmed">0{{ index + 1 }}</span>
              </div>
              <h3 class="mt-6 text-xl font-semibold text-highlighted">{{ step.title }}</h3>
              <p class="mt-3 text-base leading-7 text-muted">{{ step.description }}</p>
            </li>
          </ol>
          <p class="mt-6 text-sm leading-6 text-dimmed">Agents use a model provider you connect. Work on code also needs GitHub access and a compute node on your Cloudflare account or VPS.</p>
        </UContainer>
      </section>

      <section id="product" class="scroll-mt-20 border-b border-muted py-16 sm:py-24">
        <UContainer>
          <div class="max-w-3xl">
            <p class="mb-3 text-sm font-medium text-primary">Inside your Server</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Less switching. More shared context.</h2>
            <p class="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">Conversations, projects, tasks, mail, schedules and code live in one Server, so people and agents work from the same context.</p>
          </div>
          <div class="mt-12 grid gap-px overflow-hidden rounded-md border border-muted bg-muted md:grid-cols-2">
            <article v-for="app in featuredGroups" :id="`app-${app.id}`" :key="app.id" class="scroll-mt-24 bg-default p-8 sm:p-10">
              <div class="flex items-center gap-2 text-sm font-medium text-primary"><UIcon :name="app.icon" class="size-5" />{{ app.name }}</div>
              <h3 class="display-title mt-6 text-2xl font-semibold text-highlighted sm:text-3xl">{{ app.title }}</h3>
              <p class="mt-4 text-base leading-7 text-muted">{{ app.description }}</p>
              <p v-if="app.note" class="mt-4 text-xs leading-5 text-dimmed">{{ app.note }}</p>
            </article>
          </div>
          <div class="mt-px grid gap-px overflow-hidden rounded-md border border-muted bg-muted sm:grid-cols-2 lg:grid-cols-4">
            <article v-for="app in moreGroups" :id="`app-${app.id}`" :key="app.id" class="scroll-mt-24 bg-default p-7">
              <div class="flex items-center gap-2 text-sm font-medium text-primary"><UIcon :name="app.icon" class="size-5" />{{ app.name }}</div>
              <h3 class="mt-5 text-lg font-semibold text-highlighted">{{ app.title }}</h3>
              <p class="mt-2 text-sm leading-6 text-muted">{{ app.description }}</p>
            </article>
          </div>
          <div class="mt-6 grid gap-4 sm:grid-cols-2">
            <div v-for="app in soonGroups" :key="app.id" class="flex items-start gap-3 rounded-md border border-dashed border-muted p-5">
              <UIcon :name="app.icon" class="mt-0.5 size-5 shrink-0 text-dimmed" />
              <div class="min-w-0">
                <p class="flex items-center gap-2 text-sm font-medium text-muted">{{ app.name }}<UBadge label="Soon" color="neutral" variant="subtle" size="sm" /></p>
                <p class="mt-1 text-sm leading-6 text-dimmed">{{ app.description }}</p>
              </div>
            </div>
          </div>
        </UContainer>
      </section>

      <section class="border-b border-muted py-16 sm:py-24">
        <UContainer>
          <div class="max-w-3xl">
            <p class="mb-3 text-sm font-medium text-primary">Everything included</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Your team. Your history. Your choice.</h2>
          </div>
          <div class="mt-10 grid gap-8 md:grid-cols-3">
            <article v-for="freedom in freedoms" :key="freedom.title">
              <h3 class="text-xl font-semibold text-highlighted">{{ freedom.title }}</h3>
              <p class="mt-3 text-base leading-7 text-muted">{{ freedom.description }}</p>
            </article>
          </div>
        </UContainer>
      </section>

      <section id="run" class="scroll-mt-20 border-b border-muted py-16 sm:py-24">
        <UContainer>
          <div class="mx-auto max-w-3xl text-center">
            <p class="mb-3 text-sm font-medium text-primary">Ways to run</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Choose where your Server runs.</h2>
            <p class="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">On your Cloudflare account or on a VPS you control. Either way, you operate the Server and own its data.</p>
          </div>
          <div class="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-2">
            <UCard :ui="{ body: 'flex h-full flex-col p-7 sm:p-9' }">
              <UBadge label="From your browser" color="primary" variant="subtle" class="self-start" />
              <h3 class="mt-5 text-2xl font-semibold text-highlighted">Cloudflare</h3>
              <p class="mt-4 text-base leading-7 text-muted">Connect your Cloudflare account and deploy a Server. No Git or command line needed. Each Server gets its own database, files and realtime runtime.</p>
              <ul class="my-7 space-y-3 text-sm text-toned">
                <li>The full product, including projects and agents</li>
                <li>Optional compute node for agent work on code</li>
                <li>You pay Cloudflare directly for usage</li>
              </ul>
              <UButton :to="createUrl" label="Deploy on Cloudflare" trailing-icon="i-ph-arrow-right" size="lg" class="mt-auto self-start" />
            </UCard>
            <UCard :ui="{ body: 'flex h-full flex-col p-7 sm:p-9' }">
              <UBadge label="One command" color="neutral" variant="outline" class="self-start" />
              <h3 class="mt-5 text-2xl font-semibold text-highlighted">Your VPS</h3>
              <p class="mt-4 text-base leading-7 text-muted">Install on a Debian or Ubuntu server with Docker and HTTPS. Chat, tasks, documents and files stay on your machine.</p>
              <ul class="my-7 space-y-3 text-sm text-toned">
                <li>Your domain and local accounts</li>
                <li>Optional compute node on the same VPS</li>
                <li>Separate backups and updates you control</li>
              </ul>
              <UButton to="/create?tab=vps" label="Install on a VPS" color="neutral" variant="outline" size="lg" class="mt-auto self-start" />
            </UCard>
          </div>
        </UContainer>
      </section>

      <section class="py-16 sm:py-24">
        <UContainer>
          <div class="rounded-md border border-default bg-elevated px-6 py-14 text-center sm:px-12 sm:py-16">
            <BrandMark class="mx-auto size-12 text-highlighted" />
            <h2 class="display-title mx-auto mt-6 max-w-2xl text-4xl font-semibold text-highlighted sm:text-5xl">Bring your team and its agents together.</h2>
            <div class="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <UButton :to="createUrl" :label="createLabel" trailing-icon="i-ph-arrow-right" size="xl" />
              <UButton to="/create" label="Connect a Server" color="neutral" variant="outline" size="xl" />
            </div>
          </div>
        </UContainer>
      </section>
    </main>

    <SiteFooter />
  </div>
</template>

<style scoped>
.hero-title {
  font-size: clamp(2.75rem, 7vw, 6.25rem);
}
</style>
