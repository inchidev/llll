<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQueries, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { GitConnection } from '~~/shared/git-connections'
type Repository = { id: number; name: string; installationId: number; fork: boolean; defaultBranch: string }
const {api}=useApi(),qc=useQueryClient(),toast=useToast()
const connections=useQuery({queryKey:['git-connections'],queryFn:({signal})=>api<{connections:GitConnection[];canConfigure:boolean}>('/api/git-connections',{signal,timeout:15000})})
const github=computed(()=>(connections.data.value?.connections??[]).filter(c=>c.provider==='github'))
const enabled=computed(()=>github.value.filter(c=>c.enabled))
// Same key as the environment editor, so both views share one GitHub discovery.
const repositories=useQueries({queries:computed(()=>enabled.value.map(c=>({queryKey:['agent-repositories',c.id],queryFn:({signal}:{signal:AbortSignal})=>api<{configured:boolean;repositories:Repository[]}>('/api/code-environments/repositories',{signal,timeout:30000,query:{connectionId:c.id}}),retry:false})))})
const reposFor=(id:string)=>repositories.value[enabled.value.findIndex(c=>c.id===id)]
const prepared=ref<{actionUrl:string;manifest:Record<string,unknown>}|null>(null)
const submitted=ref(false)
const orgOpen=ref(false),detailOpen=ref(false),selectedId=ref<string|null>(null)
const selected=computed(()=>github.value.find(c=>c.id===selectedId.value))
const selectedRepos=computed(()=>selectedId.value?reposFor(selectedId.value):undefined)
let preparedConnections:string[]=[]
const organization=ref(''),busy=ref(false)
const setupWindow='l4-github-setup'
function post(actionUrl:string,manifest:Record<string,unknown>){
 const form=document.createElement('form')
 form.method='POST';form.action=actionUrl;form.target=setupWindow
 const input=document.createElement('input')
 input.type='hidden';input.name='manifest';input.value=JSON.stringify(manifest)
 form.appendChild(input);document.body.appendChild(form);form.submit();form.remove()
}
/** Opens GitHub directly. The tab is opened during the click so it is not
 * blocked; if the browser still refuses, a manual continue button remains. */
async function connect(org?:string){
 busy.value=true
 prepared.value=null;submitted.value=false
 const tab=window.open('',setupWindow)
 if(tab)tab.opener=null
 try{
  const r=await api<{actionUrl:string;manifest:Record<string,unknown>}>('/api/git-connections/github/manifest',{method:'POST',body:org?{account:org,organization:true}:{}})
  if(new URL(r.actionUrl).origin!=='https://github.com')throw Error('Unexpected GitHub destination')
  preparedConnections=(connections.data.value?.connections||[]).map(c=>c.id)
  if(tab&&!tab.closed){post(r.actionUrl,r.manifest);submitted.value=true;orgOpen.value=false}
  else{prepared.value=r;orgOpen.value=true}
 }catch(e){tab?.close();toast.add({title:errorMessage(e),color:'error'})}
 finally{busy.value=false}
}
async function resumeAfterSignIn(){
 busy.value=true
 try{
  const result=await connections.refetch()
  if(result.error)throw result.error
  if(connections.data.value?.connections.some(c=>!preparedConnections.includes(c.id))){
   prepared.value=null
   await refresh()
   return
  }
  await connect(organization.value.trim()||undefined)
 }catch(e){toast.add({title:errorMessage(e),color:'error'})}
 finally{busy.value=false}
}
async function refresh(){
 await connections.refetch()
 await qc.invalidateQueries({queryKey:['code-environments']})
 await qc.invalidateQueries({queryKey:['agent-repositories']})
}
// GitHub setup and repository selection happen in another tab; pick up the result on return.
useEventListener(window,'focus',()=>{if(submitted.value||detailOpen.value)refresh()})
defineExpose({ connect: () => connect(), openOrganization: () => { orgOpen.value = true }, refresh })
async function disconnect(id:string){
 busy.value=true
 try{await api('/api/git-connections/'+id,{method:'DELETE'});await refresh()}
 catch(e){toast.add({title:errorMessage(e),color:'error'})}finally{busy.value=false}
}
const countLabel=(id:string)=>{
 const q=reposFor(id)
 if(!q||q.isPending)return 'Loading repositories…'
 if(q.error)return 'Repositories unavailable'
 const n=q.data?.repositories.length??0
 return n?`${n} ${n===1?'repository':'repositories'}`:'No repositories selected'
}
</script>
<template>
 <section class="space-y-4">
  <LayoutLoadError v-if="connections.error.value" message="Git connections did not load." :retry="connections.refetch" />
  <UAlert v-if="submitted" title="Finish in the GitHub tab" description="Create the App, then choose which repositories L4 may use. This list updates when you return." color="neutral" variant="subtle" />
  <SettingsList :items="github" :item-key="c => c.id" :search-text="c => `${c.name} ${c.account}`" :loading="connections.isPending.value" placeholder="Search connections" :noun="['connection', 'connections']" @select="c => { selectedId = c.id; detailOpen = true }"><template #row="{ item: c }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-github-logo" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block text-sm font-medium text-highlighted">{{ c.account }}</span><span class="block text-xs text-muted">{{ c.enabled ? countLabel(c.id) : 'Disabled' }}</span></span><UBadge v-if="!c.enabled" label="Disabled" color="neutral" variant="subtle" /></template></SettingsList>
  <p v-if="connections.data.value && !github.length" class="text-sm text-muted">Connect GitHub to choose the repositories L4 may work with.</p>
  <UButton v-if="connections.data.value?.canConfigure" label="Connect a GitHub organization" color="neutral" variant="link" class="px-0" @click="orgOpen = true" />
  <SettingsEditor v-model:open="detailOpen" back="Git" :title="selected?.account ?? 'Git connection'" :description="selected ? `GitHub App ${selected.name}` : undefined"><template #body><div v-if="selected" class="space-y-4">
   <div v-if="selected.enabled" class="space-y-2">
    <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-medium text-highlighted">Repositories</h3><UButton icon="i-ph-arrows-clockwise" aria-label="Refresh repositories" color="neutral" variant="ghost" size="sm" :loading="selectedRepos?.isFetching" @click="selectedRepos?.refetch()" /></div>
    <LayoutLoadError v-if="selectedRepos?.error" message="Repositories did not load from GitHub." :retry="selectedRepos.refetch" />
    <p v-else-if="selectedRepos?.isPending" class="text-sm text-muted">Loading repositories…</p>
    <p v-else-if="!selectedRepos?.data?.repositories.length" class="text-sm text-muted">No repositories are selected for this App yet.</p>
    <ul v-else class="divide-y divide-default rounded-md border border-default">
     <li v-for="repo in selectedRepos.data.repositories" :key="repo.id" class="flex items-center gap-2 px-3 py-2 text-sm"><UIcon name="i-ph-book-bookmark" class="size-4 shrink-0 text-muted" /><span class="min-w-0 flex-1 truncate">{{ repo.name }}</span><span class="shrink-0 text-xs text-muted">{{ repo.defaultBranch }}</span><UBadge v-if="repo.fork" label="Fork" color="neutral" variant="subtle" /></li>
    </ul>
   </div>
   <p v-else class="text-sm text-muted">This connection is disabled in L4.</p>
   <div class="flex flex-wrap gap-2"><UButton v-if="selected.enabled && connections.data.value?.canConfigure" :to="selected.setupUrl" target="_blank" label="Change repositories on GitHub" icon="i-ph-arrow-square-out" color="neutral" variant="outline" /><UButton v-if="selected.enabled && connections.data.value?.canConfigure" label="Disable in L4" color="neutral" variant="ghost" :loading="busy" @click="disconnect(selected.id)" /></div>
  </div></template></SettingsEditor>
  <SettingsEditor v-model:open="orgOpen" back="Git" title="Connect GitHub" description="L4 creates a private GitHub App and you choose its repositories on GitHub."><template #body><div class="space-y-5">
  <form v-if="connections.data.value?.canConfigure && !prepared" class="space-y-3" @submit.prevent="connect(organization.trim())">
   <UFormField label="GitHub organization" help="The name in the organization's address, as in github.com/my-organization. Personal repositories need no name: use Connect GitHub instead."><UInput v-model="organization" placeholder="my-organization" class="w-full" /></UFormField>
   <p class="text-sm text-muted">You need to be an owner of this organization on GitHub. GitHub creates the App inside the organization, and only that organization can install it: an App created on your personal account cannot be added to an organization later.</p>
   <p class="text-xs text-muted">The App requests code and pull request write access for working branches and draft PRs, plus read access to issues and checks. L4 does not request branch-protection administration or configure bypass rights.</p>
   <UButton type="submit" label="Continue on GitHub" :disabled="!organization.trim()" :loading="busy" />
  </form>
  <form v-if="prepared" :action="prepared.actionUrl" method="POST" target="_blank" rel="noopener noreferrer" class="space-y-3 rounded border border-default p-3" @submit="submitted=true">
   <input type="hidden" name="manifest" :value="JSON.stringify(prepared.manifest)">
   <p class="text-sm">Your browser blocked the GitHub tab. Continue manually; this request is valid for 10 minutes.</p>
   <p class="text-sm text-muted">If GitHub asks you to sign in and then says it did not find an App Manifest, return here and prepare again. If you already created the App, refresh connections instead of creating another.</p>
   <UButton type="submit" label="Create App on GitHub" :disabled="submitted||busy" />
   <UButton type="button" label="Prepare again after GitHub sign-in" color="neutral" variant="outline" :loading="busy" @click="resumeAfterSignIn" />
  </form>
  </div></template></SettingsEditor>
 </section>
</template>
