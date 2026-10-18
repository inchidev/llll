<script setup lang="ts">
import CommunityRail from '../../../packages/client-ui/CommunityRail.vue'

const { installations, active, select, toggle } = useInstallations()
const groups = computed(() => installations.value.map(installation => ({
  ...installation,
  servers: installation.servers.filter(server => server.status === 'ready'),
})))
function connection(origin?: string) {
  window.location.assign(origin ? `/connections?instance=${encodeURIComponent(origin)}` : '/connections')
}
function open(origin: string, serverId: string) {
  if (active.value?.origin === origin && active.value.serverId === serverId) return
  select(origin, serverId)
  window.location.assign('/')
}
</script>

<template>
  <CommunityRail :groups="groups" :active-origin="active?.origin" :active-server-id="active?.serverId" @server="open" @toggle="toggle" @group="connection" @connections="connection()" @connect="navigateTo('/connections?connect=1')" @install="navigateTo('/deploy')" />
</template>
