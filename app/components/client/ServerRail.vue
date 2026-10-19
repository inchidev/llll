<script setup lang="ts">
import CommunityRail from '../../../packages/client-ui/CommunityRail.vue'
const { servers, active } = useServers()
const groups = computed(() => servers.value.map(s => ({ origin: s.origin, name: s.name, servers: [{ id: s.id, name: s.name }] })))
function open(origin: string) { location.assign(origin) }
function connect() { location.assign('https://llll.gg/create') }
</script>
<template><CommunityRail :groups="groups" :active-origin="active?.origin" :active-server-id="active?.serverId" @server="open" @connect="connect" /></template>
