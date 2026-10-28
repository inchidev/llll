<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { GitConnection } from '~~/shared/git-connections'
const {api}=useApi(),qc=useQueryClient(),toast=useToast()
const connections=useQuery({queryKey:['git-connections'],queryFn:()=>api<{connections:GitConnection[];canConfigure:boolean}>('/api/git-connections')})
const prepared=ref<{actionUrl:string;manifest:Record<string,unknown>}|null>(null)
const submitted=ref(false)
const connectOpen=ref(false),detailOpen=ref(false),selectedId=ref<string|null>(null)
const selected=computed(()=>connections.data.value?.connections.find(c=>c.id===selectedId.value))
let preparedConnections:string[]=[]
const name=ref('L4 project code'),account=ref(''),organization=ref(false),busy=ref(false)
async function connect(){
 busy.value=true
 prepared.value=null;submitted.value=false
 try{
  const r=await api<{actionUrl:string;manifest:Record<string,unknown>}>('/api/git-connections/github/manifest',{method:'POST',body:{name:name.value,account:account.value,organization:organization.value}})
  const target=new URL(r.actionUrl)
  if(target.origin!=='https://github.com')throw Error('Unexpected GitHub destination')
  prepared.value=r
  preparedConnections=(connections.data.value?.connections||[]).map(c=>c.id)
  busy.value=false
 }catch(e){toast.add({title:errorMessage(e),color:'error'});busy.value=false}
}
async function resumeAfterSignIn(){
 busy.value=true
 try{
  const result=await connections.refetch()
  if(result.error)throw result.error
  if(connections.data.value?.connections.some(c=>!preparedConnections.includes(c.id))){
   prepared.value=null
   await qc.invalidateQueries({queryKey:['code-environments']})
   await qc.invalidateQueries({queryKey:['agent-repositories']})
   return
  }
  await connect()
 }catch(e){toast.add({title:errorMessage(e),color:'error'})}
 finally{busy.value=false}
}
watch([name,account,organization],()=>{prepared.value=null})
async function refresh(){
 await connections.refetch()
 await qc.invalidateQueries({queryKey:['code-environments']})
 await qc.invalidateQueries({queryKey:['agent-repositories']})
}
async function disconnect(id:string){
 busy.value=true
 try{await api('/api/git-connections/'+id,{method:'DELETE'});await connections.refetch();await qc.invalidateQueries({queryKey:['code-environments']});await qc.invalidateQueries({queryKey:['agent-repositories']})}
 catch(e){toast.add({title:errorMessage(e),color:'error'})}finally{busy.value=false}
}
</script>
<template>
 <section class="space-y-4">
  <h2 class="font-medium">Git provider connections</h2>
  <p class="text-sm text-muted">Connect a GitHub App, then choose the repositories it can access on GitHub. L4 keeps its credentials on this Server and checks each operation against project and Role permissions.</p>
  <div class="flex flex-wrap gap-3"><UButton v-if="connections.data.value?.canConfigure" label="Connect GitHub" icon="i-ph-plus" @click="connectOpen=true" /><UButton label="Refresh connections" color="neutral" variant="outline" @click="refresh" /></div>
  <LayoutLoadError v-if="connections.error.value" message="Git connections did not load." :retry="connections.refetch" />
  <SettingsList :items="connections.data.value?.connections ?? []" :item-key="c => c.id" :search-text="c => `${c.name} ${c.account}`" :loading="connections.isPending.value" placeholder="Search connections" :noun="['connection', 'connections']" @select="c => { selectedId = c.id; detailOpen = true }"><template #row="{ item: c }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-git-branch" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block text-sm font-medium text-highlighted">{{ c.name }}</span><span class="block text-xs text-muted">{{ c.account }}</span></span><UBadge :label="c.enabled ? 'Active' : 'Disabled'" :color="c.enabled ? 'success' : 'neutral'" /></template></SettingsList>
  <UModal v-model:open="detailOpen" :title="selected?.name ?? 'Git connection'" description="Manage the repositories this connection can access."><template #body><div v-if="selected" class="space-y-4"><p>{{selected.account}} · {{selected.enabled ? 'Active' : 'Disabled'}}</p><div class="flex flex-wrap gap-2"><UButton v-if="selected.enabled && connections.data.value?.canConfigure" :to="selected.setupUrl" target="_blank" label="Choose repositories on GitHub" color="neutral" variant="outline" /><UButton v-if="selected.enabled && connections.data.value?.canConfigure" label="Disable in L4" color="neutral" variant="ghost" :loading="busy" @click="disconnect(selected.id)" /></div></div></template></UModal>
  <UModal v-model:open="connectOpen" title="Connect GitHub" description="Create a GitHub App owned by your account or organization."><template #body><div class="space-y-5">
  <form v-if="connections.data.value?.canConfigure" class="space-y-3" @submit.prevent="connect">
   <UFormField label="Connection name"><UInput v-model="name" class="w-full" /></UFormField>
   <UFormField label="GitHub account or organization"><UInput v-model="account" placeholder="Your GitHub username or organization" class="w-full" /></UFormField>
   <UCheckbox v-model="organization" label="Create the App in a GitHub organization" />
   <p class="text-xs text-muted">GitHub will ask you to create the App and authorize selected repositories. It requests code and pull request write access for working branches and draft PRs, plus read access to issues and checks. L4 does not request branch-protection administration or configure bypass rights.</p>
   <UButton type="submit" label="Prepare GitHub connection" :disabled="!name.trim()||!account.trim()" :loading="busy" />
  </form>
  <form v-if="prepared" :action="prepared.actionUrl" method="POST" target="_blank" rel="noopener noreferrer" class="space-y-3 rounded border border-default p-3" @submit="submitted=true">
   <input type="hidden" name="manifest" :value="JSON.stringify(prepared.manifest)">
   <p class="text-sm">Continue in a new tab to create the App on GitHub. This setup request is valid for 10 minutes. Return here and refresh connections after GitHub finishes.</p>
   <p class="text-sm text-muted">If GitHub asks you to sign in or confirm access and then says it did not find an App Manifest, finish signing in and return here. Prepare again below to send a fresh request. If you already created the App, choose its repositories and refresh connections instead of creating another App.</p>
   <UButton type="submit" label="Create App on GitHub" :disabled="submitted||busy" />
   <UButton type="button" label="Prepare again after GitHub sign-in" color="neutral" variant="outline" :loading="busy" @click="resumeAfterSignIn" />
  </form>
  </div></template></UModal>
 </section>
</template>
