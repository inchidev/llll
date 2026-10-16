<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

const repoUrl = 'https://github.com/inchidev/llll'
const sandboxUrl = 'https://sandbox.llll.gg'
const siteUrl = 'https://llll.gg/'
const pageTitle = 'L4 — Chat and work together. Run it yourself.'
const pageDescription = 'Bring team chat, tasks, shared email, knowledge, and internal tools together. AI teammates, custom internal apps, and no seat fees. Run on your Cloudflare account or VPS.'

const navigation = computed<NavigationMenuItem[]>(() => [
  { label: 'Product', to: '#product' },
  { label: 'Apps', to: '#app-apps' },
  { label: 'Ways to run', to: '#run' },
  { label: 'Docs', to: `${repoUrl}/tree/main/docs` },
])

const compactNavigation = computed<DropdownMenuItem[]>(() => navigation.value.map(({ label, to }) => ({ label, to })))
const primaryActionLabel = 'Install your own'
const productGroups = [
  { name: 'Chat', icon: 'i-ph-chats-circle', title: 'Keep the conversation together.', description: 'Channels, direct messages, threads, and shared files. Move from a message to a call or a Live room when talking is easier.', note: 'Voice and video are optional.' },
  { name: 'Tasks', icon: 'i-ph-kanban', title: 'Know what happens next.', description: 'Turn plans into shared boards with priorities, due dates, checklists, and dependencies. Give each task a responsible teammate and a place to discuss it.' },
  { name: 'Mail', icon: 'i-ph-envelope-simple', title: 'An inbox the team can share.', description: 'Receive and reply from your own domain. Keep email conversations and internal notes together, with access for the people who need it.', note: 'Connect an email domain to enable Mail.' },
  { name: 'Data', icon: 'i-ph-table', title: 'Make knowledge easy to find.', description: 'Organize records in tables, boards, lists, and calendars. Keep documents and canvases alongside them, and bookmark what matters to you.' },
]

const freedoms = [
  { title: 'Invite everyone.', description: 'No seat fees. Your team can grow without buying access for each person.' },
  { title: 'Keep your history.', description: 'No retention tier. Conversations stay searchable until you choose to delete them.' },
  { title: 'Own your workspace.', description: 'MIT software. Run independent installations with isolated servers on Cloudflare or your VPS.' },
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
  ogImageAlt: 'L4 — Chat. Work. On your terms.',
  twitterCard: 'summary_large_image',
  twitterTitle: pageTitle,
  twitterDescription: pageDescription,
  twitterImage: 'https://llll.gg/og-image.png',
  twitterImageAlt: 'L4 — Chat. Work. On your terms.',
})

useHead({
  link: [
    { rel: 'canonical', href: siteUrl },
  ],
  script: [{
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
      offers: { '@type': 'Offer', name: 'Free software on your Cloudflare account', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Five built-in apps: Chat, Tasks, Mail, Data, Apps',
        'AI agents in chat who can read and create Tasks',
        'Optional voice, video, and screen sharing through RealtimeKit',
        'Unlimited customer-owned workspaces, members, and message history',
        'Independent installations with local accounts',
      ],
    }),
  }],
})
</script>

<template>
  <div class="landing min-h-screen overflow-x-clip bg-default text-default">
    <UHeader to="/" title="L4" :toggle="false" class="border-b border-muted/70 bg-default/80 backdrop-blur-xl">
      <template #title><BrandLogo :linked="false" /></template>
      <UNavigationMenu :items="navigation" class="hidden lg:flex" />
      <template #right>
        <UButton :to="sandboxUrl" target="_blank" label="Try sandbox" color="neutral" variant="ghost" class="hidden sm:inline-flex" />
        <UButton to="/open" label="Open L4" color="neutral" variant="outline" />
        <UDropdownMenu :items="compactNavigation" :content="{ align: 'end', sideOffset: 12 }" :ui="{ content: 'w-56' }">
          <UButton icon="i-ph-list" aria-label="Open menu" color="neutral" variant="ghost" class="lg:hidden" />
        </UDropdownMenu>
      </template>
    </UHeader>

    <main>
      <section class="hero relative isolate border-b border-muted py-12 sm:py-20 lg:py-16">
        
        
        <UContainer>
          <div class="mx-auto max-w-4xl text-center">

            <p class="mb-6 text-xs font-medium uppercase tracking-[.18em] text-muted">Independent by design</p>
            <h1 class="display-title text-[42px] font-semibold leading-[1.02] text-highlighted sm:text-7xl lg:text-8xl">Chat. Work. <span class="block text-muted">On your terms.</span></h1>
            <p class="mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted sm:text-xl">Free, open-source chat, tasks, mail and data. One installation, many servers. Run it on your own infrastructure.</p>
            <div class="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <UButton to="/deploy" external :label="primaryActionLabel" trailing-icon="i-ph-arrow-right" size="xl" />
              <UButton :to="sandboxUrl" target="_blank" label="Try the sandbox" icon="i-ph-play-circle" color="neutral" variant="outline" size="xl" />
            </div>
            <p class="mt-4 text-xs text-dimmed">MIT licensed. Cloudflare or your VPS. No seat fees.</p>
          </div>
          <ProductPreview class="mx-auto mt-8 max-w-6xl" />
        </UContainer>
      </section>

      <section id="product" class="scroll-mt-20 border-b border-muted py-14 sm:py-24">
        <UContainer>
          <div class="max-w-3xl">
            <p class="mb-3 text-sm font-medium text-primary">Four groups. One team.</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Less switching. More shared context.</h2>
            <p class="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">Chat, Tasks, Mail, and Data bring the everyday work together, with the same people and permissions.</p>
          </div>
          <div class="mt-12 grid gap-px overflow-hidden rounded-md border border-muted bg-muted sm:grid-cols-2">
            <article v-for="app in productGroups" :id="`app-${app.name.toLowerCase()}`" :key="app.name" class="scroll-mt-24 bg-default p-7 sm:p-8">
              <div class="flex items-center gap-2 text-sm font-medium text-primary"><UIcon :name="app.icon" class="size-5" />{{ app.name }}</div>
              <h3 class="mt-6 text-xl font-semibold text-highlighted">{{ app.title }}</h3>
              <p class="mt-3 text-base leading-7 text-muted">{{ app.description }}</p>
              <p v-if="app.note" class="mt-4 text-xs leading-5 text-dimmed">{{ app.note }}</p>
            </article>
          </div>
          <div class="mt-8 rounded-md border border-default bg-elevated p-7 sm:p-9">
            <div class="flex items-center gap-2 text-sm font-medium text-primary"><UIcon name="i-ph-robot" class="size-5" />AI teammates</div>
            <h3 class="display-title mt-4 text-2xl font-semibold text-highlighted sm:text-3xl">Bring an agent into the conversation.</h3>
            <p class="mt-4 max-w-3xl text-base leading-7 text-muted">Give an agent a profile, talk to it in a channel or direct message, and ask it to read or create tasks. Your team decides who can use and configure agents.</p>
            <NuxtLink :to="`${repoUrl}/blob/main/docs/architecture.md`" class="mt-5 inline-flex items-center gap-2 text-sm text-primary hover:underline">Meet the agents <UIcon name="i-ph-arrow-right" class="size-4" /></NuxtLink>
          </div>
        </UContainer>
      </section>

      <section id="app-apps" class="scroll-mt-20 border-b border-muted py-14 sm:py-24">
        <UContainer>
          <div class="max-w-3xl">
            <p class="mb-3 text-sm font-medium text-primary">Apps</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Want more?</h2>
            <p class="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">Build tools around the way your team works. Use shared records to build the internal tools your community needs.</p>
          </div>
          <div class="mt-10 rounded-md border border-default bg-elevated p-7 sm:p-9">
            <UBadge label="Built-in Apps · Available now" color="primary" variant="subtle" />
            <h3 class="display-title mt-5 text-2xl font-semibold text-highlighted sm:text-3xl">Your data. Your tools.</h3>
            <p class="mt-4 max-w-3xl text-base leading-7 text-muted">Turn workspace records into shared lists, tables, and metrics: a client directory, a sales console, or a project dashboard. Choose what each app can show or change, then publish it to the right roles.</p>
            <p class="mt-4 text-base leading-7 text-muted">Create and publish these tools with the built-in Apps editor.</p>
            <NuxtLink :to="`${repoUrl}/blob/main/README.md`" class="mt-5 inline-flex items-center gap-2 text-sm text-primary hover:underline">Explore built-in Apps <UIcon name="i-ph-arrow-right" class="size-4" /></NuxtLink>
          </div>
        </UContainer>
      </section>

      <section class="border-b border-muted py-14 sm:py-24">
        <UContainer>
          <div class="max-w-3xl">
            <p class="mb-3 text-sm font-medium text-primary">Free stays complete</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Your team. Your history. Your choice.</h2>
          </div>
          <div class="mt-10 grid gap-8 md:grid-cols-3">
            <article v-for="freedom in freedoms" :key="freedom.title">
              <h3 class="text-xl font-semibold text-highlighted">{{ freedom.title }}</h3>
              <p class="mt-3 text-base leading-7 text-muted">{{ freedom.description }}</p>
            </article>
          </div>
          <p class="mt-8 text-xs leading-5 text-dimmed">L4 adds no member, history, mailbox, or record tiers. Your infrastructure and connected providers determine capacity and usage costs.</p>
        </UContainer>
      </section>

      <section id="run" class="scroll-mt-20 border-b border-muted py-14 sm:py-24">
        <UContainer>
          <div class="mx-auto max-w-3xl text-center">
            <p class="mb-3 text-sm font-medium text-primary">Ways to run</p>
            <h2 class="display-title text-4xl font-semibold text-highlighted sm:text-5xl">Choose where to run L4.</h2>
            <p class="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">Run on your Cloudflare account, or use celld on your VPS. In either case, you operate the installation and own its data.</p>
          </div>
          <div class="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-2">
            <UCard :ui="{ body: 'flex h-full flex-col p-7 sm:p-9' }">
              <UBadge label="Your account" color="primary" variant="subtle" class="self-start" />
              <h3 class="mt-5 text-2xl font-semibold text-highlighted">Run on Cloudflare</h3>
              <p class="mt-4 text-base leading-7 text-muted">Connect your Cloudflare account, deploy an installation, then create isolated servers. Each server has its own database, files and realtime runtime.</p>
              <ul class="my-7 space-y-3 text-sm text-toned">
                <li>Full MIT product, including all five apps and agents</li>
                <li>No seats, history tiers, or reduced open-source edition</li>
                <li>You pay Cloudflare directly for infrastructure usage</li>
              </ul>
              <UButton to="/deploy" external :label="primaryActionLabel" trailing-icon="i-ph-arrow-right" size="lg" class="mt-auto self-start" />
            </UCard>
            <UCard :ui="{ body: 'flex h-full flex-col p-7 sm:p-9' }">
              <UBadge label="Docker Compose · Coolify" color="neutral" variant="outline" class="self-start" />
              <h3 class="mt-5 text-2xl font-semibold text-highlighted">Run on your VPS</h3>
              <p class="mt-4 text-base leading-7 text-muted">The same server logic on celld. Keep chat, tasks, documents and files on your own machine. Connect optional calls, AI and mail providers when you need them.</p>
              <ul class="my-7 space-y-3 text-sm text-toned"><li>Local accounts and your own domain</li><li>One private runtime and database per server</li><li>Separate backups and operator-controlled updates</li></ul>
              <UButton to="/deploy?method=vps" label="VPS setup" color="neutral" variant="outline" size="lg" class="mt-auto self-start" />
            </UCard>
          </div>
        </UContainer>
      </section>

      <section class="py-14 sm:py-24">
        <UContainer>
          <div class="relative isolate overflow-hidden rounded-md border border-default bg-elevated px-6 py-14 text-center sm:px-12 sm:py-16">
            <div class="pointer-events-none absolute inset-0 -z-10" />
            <img src="/brand/logo-128.png" alt="" class="mx-auto size-16" width="64" height="64">
            <h2 class="display-title mx-auto mt-6 max-w-2xl text-4xl font-semibold text-highlighted sm:text-5xl">Give your team a place to work together.</h2>
            <div class="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <UButton to="/deploy" external :label="primaryActionLabel" trailing-icon="i-ph-arrow-right" size="xl" />
              <UButton :to="sandboxUrl" target="_blank" label="Try the sandbox" icon="i-ph-play-circle" color="neutral" variant="outline" size="xl" />
            </div>
          </div>
        </UContainer>
      </section>
    </main>

    <footer class="relative isolate overflow-hidden border-t border-muted bg-muted/40 py-12 sm:py-16">
      <div class="pointer-events-none absolute inset-0 -z-10 opacity-60" />
      <UContainer>
        <div class="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-4">
          <div class="col-span-2 sm:col-span-3 lg:col-span-1">
            <p class="display-title text-2xl font-semibold text-highlighted">Your workspace, your way.</p>
            <p class="mt-4 max-w-sm text-base leading-7 text-muted">A place for your team and its agents to talk, plan, and build together.</p>
            <UButton to="/deploy" external :label="primaryActionLabel" trailing-icon="i-ph-arrow-right" color="neutral" variant="outline" class="mt-5" />
          </div>
          <nav aria-label="Footer product">
            <p class="mb-4 text-sm font-semibold text-highlighted">Product</p>
            <ul class="space-y-3 text-sm text-muted">
              <li v-for="app in productGroups" :key="app.name"><a :href="`#app-${app.name.toLowerCase()}`" class="hover:text-highlighted">{{ app.name }}</a></li>
              <li><a href="#app-apps" class="hover:text-highlighted">Apps</a></li>
              <li><a href="#run" class="hover:text-highlighted">Ways to run</a></li>
            </ul>
          </nav>
          <nav aria-label="Footer resources">
            <p class="mb-4 text-sm font-semibold text-highlighted">Resources</p>
            <ul class="space-y-3 text-sm text-muted">
              <li><NuxtLink :to="`${repoUrl}/tree/main/docs`" class="hover:text-highlighted">Documentation</NuxtLink></li>
              <li><NuxtLink to="/deploy" class="hover:text-highlighted">Setup guide</NuxtLink></li>
              <li><ULink :to="sandboxUrl" target="_blank" class="hover:text-highlighted">Try the sandbox</ULink></li>
              <li><ULink :to="repoUrl" target="_blank" class="hover:text-highlighted">GitHub</ULink></li>
            </ul>
          </nav>
          <nav aria-label="Footer company">
            <p class="mb-4 text-sm font-semibold text-highlighted">Company</p>
            <ul class="space-y-3 text-sm text-muted">
              <li><NuxtLink to="/privacy" class="hover:text-highlighted">Privacy</NuxtLink></li>
              <li><NuxtLink to="/terms" class="hover:text-highlighted">Terms</NuxtLink></li>
              <li><ULink :to="`${repoUrl}/issues`" class="hover:text-highlighted">Contact</ULink></li>
              
            </ul>
          </nav>
        </div>
        <div class="mt-10 flex w-full flex-col gap-5 border-t border-muted pt-8 sm:flex-row sm:items-center sm:justify-between">
          <BrandLogo />
          <div class="flex items-center justify-between gap-6 sm:justify-end">
            <div class="text-xs leading-5 text-dimmed">
              <p>A project by Inchi</p>
              <p>Independent project · MIT licensed</p>
            </div>
            <UColorModeButton color="neutral" variant="outline" />
          </div>
        </div>
      </UContainer>
    </footer>
  </div>
</template>
