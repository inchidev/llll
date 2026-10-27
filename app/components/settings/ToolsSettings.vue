<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import { outboundMcpProviders, type McpConnectionDTO, type McpConnectionInput } from '~~/shared/outbound-mcp'
import type { ToolsSettingsDTO, ToolAuditPage } from '~~/shared/agent-tools-settings'
const props=defineProps<{serverId:string}>()
const emit=defineEmits<{roles:[]}>()
const {api}=useApi(), qc=useQueryClient(), toast=useToast()
const {can}=useRoleGrants()
const root=computed(()=>`/api/servers/${props.serverId}`)
const tab=ref('installed'), selectedAgent=ref<string>(), search=ref(''), auditSearch=ref(''), page=ref(1)
const tabs=[{label:'Installed',value:'installed'},{label:'Discover / Connect',value:'connect'},{label:'Permissions',value:'permissions'},{label:'Approvals',value:'approvals'},{label:'Audit',value:'audit'}]
const settingsQ=useQuery({queryKey:computed(()=>['tool-settings',props.serverId,selectedAgent.value]),queryFn:()=>api<ToolsSettingsDTO>(root.value+'/tools'+(selectedAgent.value?'?agentId='+encodeURIComponent(selectedAgent.value):'')),refetchInterval:15000})
const settings=computed(()=>settingsQ.data.value)
const connectionsQ=useQuery({queryKey:computed(()=>['tool-connections',props.serverId]),queryFn:()=>api<{connections:McpConnectionDTO[]}>(root.value+'/tool-connections'),enabled:computed(()=>Boolean(settings.value?.mayConnect)),refetchInterval:15000})
const auditQ=useQuery({queryKey:computed(()=>['tool-audit',props.serverId,auditSearch.value,page.value]),queryFn:()=>api<ToolAuditPage>(root.value+'/tool-audit?search='+encodeURIComponent(auditSearch.value)+'&page='+page.value),enabled:computed(()=>tab.value==='audit'&&Boolean(settings.value?.mayAudit))})
watch(auditSearch,()=>{page.value=1})
const agentOptions=computed(()=>(settings.value?.agents??[]).map(a=>({label:a.name+(a.status==='active'?'':' (paused)'),value:a.id})))
const memberOptions=computed(()=>(settings.value?.members??[]).map(m=>({label:m.name,value:m.id})))
const roleOptions=computed(()=>(settings.value?.roles??[]).map(r=>({label:r.name,value:r.id})))
const connections=computed(()=>connectionsQ.error.value||!settings.value?.mayConnect?[]:connectionsQ.data.value?.connections??[])
const tools=computed(()=>(settings.value?.preview?.tools??[]).filter(tool=>(tool.name+' '+tool.description+' '+(tool.provenance?.connectionName??'')).toLowerCase().includes(search.value.toLowerCase())))
const editorOpen=ref(false), editing=ref<string|null>(null), busy=ref(''), error=ref(''), removeTarget=ref<McpConnectionDTO|null>(null)
const fresh=():McpConnectionInput=>({name:'',providerId:'cloudflare-docs',ownership:settings.value?.mayManageServer?'server':'member',enabled:false,grants:{agentIds:[],memberIds:[],roleIds:[]},toolNames:['search_cloudflare_documentation'],credentialExpiresAt:null})
const form=reactive(fresh())
const credential=ref(''), credentialAction=ref('keep'), expiry=ref('')
const provider=computed(()=>outboundMcpProviders.find(p=>p.id===form.providerId)!)
watch(()=>form.providerId,()=>{if(!editing.value)form.toolNames=[provider.value.readTools[0]]})
watch(()=>form.ownership,value=>{if(value==='member'){form.grants.memberIds=[];form.grants.roleIds=[]}})
function openEditor(connection?:McpConnectionDTO, providerId?:McpConnectionInput['providerId']) {
  editing.value=connection?.id??null
  Object.assign(form,connection?{name:connection.name,providerId:connection.providerId,ownership:connection.ownership,enabled:connection.enabled,grants:{agentIds:[...connection.grants.agentIds],memberIds:[...connection.grants.memberIds],roleIds:[...connection.grants.roleIds]},toolNames:[...connection.toolNames],credentialExpiresAt:connection.credentialExpiresAt}:fresh())
  if(providerId&&!connection)form.providerId=providerId
  credential.value='';credentialAction.value='keep';expiry.value=connection?.credentialExpiresAt??'';error.value='';editorOpen.value=true
}
watch(editorOpen,open=>{if(!open){credential.value='';credentialAction.value='keep'}})
const config=(c:McpConnectionDTO):McpConnectionInput=>({name:c.name,providerId:c.providerId as McpConnectionInput['providerId'],ownership:c.ownership,enabled:c.enabled,grants:c.grants,toolNames:c.toolNames,credentialExpiresAt:c.credentialExpiresAt})
async function reload(){await qc.invalidateQueries({queryKey:['tool-connections',props.serverId]});await qc.invalidateQueries({queryKey:['tool-settings',props.serverId]});await qc.invalidateQueries({queryKey:['tool-audit',props.serverId]})}
async function action(id:string,operation:()=>Promise<unknown>,success:string){if(busy.value)return;busy.value=id;error.value='';try{await operation();await reload();toast.add({title:success,color:'success'})}catch(cause){error.value=errorMessage(cause)}finally{busy.value=''}}
async function save(){
  const body:McpConnectionInput={...form,enabled:false,grants:{agentIds:[...form.grants.agentIds],memberIds:[...form.grants.memberIds],roleIds:[...form.grants.roleIds]},toolNames:[...form.toolNames],credentialExpiresAt:expiry.value||null}
  if(credentialAction.value==='remove')body.credential=null
  if(credentialAction.value==='replace')body.credential=credential.value
  await action('save',async()=>{await api(root.value+'/tool-connections'+(editing.value?'/'+editing.value:''),{method:editing.value?'PUT':'POST',body});editorOpen.value=false;credential.value=''},'Connection saved')
  // Never retain submitted credentials after an error or a successful request.
  credential.value=''
}
const health=(c:McpConnectionDTO)=>c.credentialExpiresAt&&Date.parse(c.credentialExpiresAt)<=Date.now()?'Credentials expired':c.lastError?'Needs attention':!c.tools.length?'Refresh required':c.enabled?'Enabled':'Disabled'
function toggle(c:McpConnectionDTO){void action(c.id,()=>api(root.value+'/tool-connections/'+c.id,{method:'PUT',body:{...config(c),enabled:!c.enabled}}),c.enabled?'Connection disabled':'Connection enabled')}
function refresh(c:McpConnectionDTO){void action(c.id,()=>api(root.value+'/tool-connections/'+c.id+'/refresh',{method:'POST',body:{}}),'Reviewed tools refreshed; start a new Run')}
async function remove(){const c=removeTarget.value;if(!c)return;await action(c.id,async()=>{await api(root.value+'/tool-connections/'+c.id,{method:'DELETE'});removeTarget.value=null},'Connection revoked')}
</script>
<template>
  <div class="min-w-0 space-y-5">
    <div><h1 class="text-xl font-semibold text-highlighted">Tools</h1><p class="mt-2 text-sm text-muted">Connect read-only sources, inspect Agent capabilities and review tool activity.</p></div>
    <UAlert color="neutral" title="Sensitive tool calls require review" description="Workspace actions use exact review in the initiating Member’s private Run. Other model-selected outbound calls and Server writes remain blocked. Connection setup and health checks remain available." />
    <nav class="flex flex-wrap gap-2" aria-label="Tools sections"><UButton v-for="item in tabs" :key="item.value" :label="item.label" :aria-pressed="tab===item.value" :variant="tab===item.value?'solid':'outline'" color="neutral" @click="tab=item.value" /></nav>
    <LayoutSkeleton v-if="settingsQ.isPending.value" variant="form" />
    <LayoutLoadError v-else-if="settingsQ.error.value" message="Tools could not be loaded." :retry="settingsQ.refetch" />
    <template v-else-if="settings">
      <UAlert v-if="error" color="error" title="Tools could not be updated" :description="error" />
      <template v-if="tab==='installed'">
        <div class="grid gap-3 sm:grid-cols-2"><article v-for="capability in settings.capabilities" :key="capability.name" class="rounded-lg border border-default p-4"><p class="font-medium">{{ capability.name }}</p><p class="mt-1 text-xs text-muted">{{ capability.available?'Configured':'Unavailable' }}</p><p class="mt-2 text-sm text-muted">{{ capability.detail }}</p></article></div>
        <section class="space-y-3"><div class="flex flex-wrap items-center gap-3"><h2 class="flex-1 font-medium">MCP connections you manage</h2><UButton v-if="settings.mayConnect" label="Connect source" icon="i-ph-plus" @click="openEditor()" /></div>
          <p v-if="!settings.mayConnect" class="text-sm text-muted">Your Role needs Use external tools to manage connections. Restricted connections are not listed.</p>
          <LayoutLoadError v-else-if="connectionsQ.error.value" message="Connections could not be loaded." :retry="connectionsQ.refetch" />
          <p v-else-if="connectionsQ.isPending.value" role="status">Loading connections…</p><p v-else-if="!connections.length" class="text-sm text-muted">No connections you can manage. Connect a reviewed public source to get started.</p>
          <article v-for="connection in connections" :key="connection.id" class="min-w-0 space-y-3 rounded-lg border border-default p-4">
            <div class="flex flex-wrap items-center gap-2"><h3 class="min-w-0 flex-1 break-words font-medium">{{ connection.name }}</h3><UBadge :label="health(connection)" color="neutral" variant="subtle" /></div>
            <p class="text-xs text-muted">{{ connection.ownership==='server'?'Server-owned':'Personal' }} · {{ connection.providerId }} · revision {{ connection.revision }}</p>
            <p class="text-xs text-muted">{{ connection.checkedAt?'Last checked '+new Date(connection.checkedAt).toLocaleString():'Not checked yet' }} · {{ connection.hasCredential?'Credential saved (hidden)':'Public connection' }}</p>
            <p v-if="connection.lastError" class="text-sm text-warning">Refresh or reconnect this source. Status: {{ connection.lastError }}</p>
            <p v-if="connection.credentialExpiresAt" class="text-xs text-muted">Credential expiry: {{ new Date(connection.credentialExpiresAt).toLocaleString() }}</p>
            <div class="flex flex-wrap gap-2"><UButton label="Edit connection" color="neutral" variant="outline" :disabled="Boolean(busy)" @click="openEditor(connection)" /><UButton label="Refresh tools" color="neutral" variant="outline" :loading="busy===connection.id" @click="refresh(connection)" /><UButton :label="connection.enabled?'Disable':'Enable'" color="neutral" variant="outline" :disabled="Boolean(busy)||(!connection.enabled&&(!connection.tools.length||Boolean(connection.lastError)))" @click="toggle(connection)" /><UButton label="Revoke" color="error" variant="soft" :disabled="Boolean(busy)" @click="removeTarget=connection" /></div>
            <details v-for="tool in connection.tools" :key="tool.name" class="min-w-0 rounded border border-default p-3"><summary class="cursor-pointer break-all text-sm">{{ tool.remoteName }} · read-only</summary><p class="mt-2 break-words text-sm text-muted">{{ tool.description }}</p><p class="mt-2 break-all text-xs text-muted">{{ tool.name }} · {{ tool.hash }}</p><pre class="mt-2 max-h-64 overflow-auto text-xs">{{ JSON.stringify(tool.parameters,null,2) }}</pre></details>
          </article>
        </section>
      </template>
      <template v-else-if="tab==='connect'">
        <p class="text-sm text-muted">Only reviewed public HTTPS providers are supported. External writes, custom endpoints, local commands and automatic OAuth authorization are unavailable.</p>
        <article v-for="source in outboundMcpProviders" :key="source.id" class="space-y-3 rounded-lg border border-default p-4"><h2 class="font-medium">{{ source.name }}</h2><p class="break-all text-xs text-muted">{{ source.endpoint }}</p><ul class="list-inside list-disc break-all text-sm"><li v-for="name in source.readTools" :key="name">{{ name }} · read-only</li></ul><UButton label="Connect" :disabled="!settings.mayConnect" @click="openEditor(undefined,source.id)" /></article>
        <p v-if="!settings.mayConnect" class="text-sm text-muted">Ask an authorized Role manager for Use external tools. This grant does not share a connection.</p>
      </template>
      <template v-else-if="tab==='permissions'">
        <p class="text-sm text-muted">Agent Role ∩ initiating Member rights ∩ Task/resources ∩ connection grants ∩ Run mandate. A toggle never overrides those checks. Built-in write tools retain existing permissions; new external tools are read-only.</p>
        <UButton v-if="can(Permission.manageRoles)" label="Manage Roles" color="neutral" variant="outline" @click="emit('roles')" />
        <UFormField label="Preview tools for Agent"><USelect v-model="selectedAgent" :items="agentOptions" placeholder="Choose an Agent" value-key="value" class="w-full" aria-label="Preview tools for Agent" :disabled="!settings.mayPreview" /></UFormField>
        <p v-if="!settings.mayPreview" class="text-sm text-muted">Use agents is required to preview work initiated by you.</p>
        <ul v-if="settings.preview" class="space-y-2 text-sm text-muted"><li v-for="diagnostic in settings.preview.diagnostics" :key="diagnostic">{{ diagnostic }}</li></ul>
        <UInput v-if="settings.preview" v-model="search" aria-label="Search visible tools" placeholder="Search visible tools" class="w-full" />
        <p v-if="settings.preview&&!tools.length" class="text-sm text-muted">No tools match the current access and search.</p>
        <details v-for="tool in tools" :key="tool.name" class="min-w-0 rounded-lg border border-default p-4"><summary class="cursor-pointer break-all text-sm">{{ tool.provenance?.remoteName??tool.name }} · {{ tool.guidance.effect }} · {{ tool.guidance.cost }}</summary><p class="mt-2 break-words text-sm">{{ tool.description }}</p><p v-if="tool.provenance" class="mt-2 break-words text-xs text-muted">Connection: {{ tool.provenance.connectionName }} · revision {{ tool.provenance.revision }}</p><p class="mt-2 text-sm text-muted">{{ tool.guidance.trust }}</p><pre class="mt-2 max-h-64 overflow-auto text-xs">{{ JSON.stringify(tool.parameters,null,2) }}</pre></details>
      </template>
      <template v-else-if="tab==='approvals'"><UAlert color="neutral" title="Review workspace actions in the private Run" description="The initiating Member reviews exact workspace commands, network hosts, changes and GitHub publication in that Run. General external-tool approvals remain unavailable; connection grants alone do not enable invocation." /></template>
      <template v-else-if="tab==='audit'">
        <p class="text-sm text-muted">Safe activity for connections you manage. Prompts, arguments, results and credentials are excluded. Personal connections stay private, including from the Server Owner.</p>
        <UInput v-if="settings.mayAudit" v-model="auditSearch" aria-label="Search tool audit" placeholder="Search connection, actor, tool or status" class="w-full" />
        <p v-if="!settings.mayAudit" class="text-sm text-muted">Use external tools is required to inspect your connection activity.</p>
        <LayoutLoadError v-else-if="auditQ.error.value" message="Tool activity could not be loaded." :retry="auditQ.refetch" />
        <p v-else-if="auditQ.isPending.value" role="status">Loading activity…</p><p v-else-if="!auditQ.data.value?.entries.length" class="text-sm text-muted">No matching activity.</p>
        <article v-for="entry in auditQ.error.value||!settings.mayAudit?[]:auditQ.data.value?.entries??[]" :key="entry.id" class="space-y-2 rounded border border-default p-3 text-sm"><p class="break-words">{{ entry.actorName }} · {{ entry.action }} · {{ entry.status??'recorded' }}</p><p class="break-words text-muted">{{ entry.connectionName??'Removed connection' }}</p><p v-if="entry.tool" class="break-all">{{ entry.tool }}</p><p class="text-xs text-muted">{{ new Date(entry.createdAt).toLocaleString() }}</p><div class="flex flex-wrap gap-3"><NuxtLink v-if="entry.runId" :to="'/runs/'+entry.runId" class="text-primary underline">Run</NuxtLink><NuxtLink v-if="entry.taskId" :to="'/tasks?task='+entry.taskId" class="text-primary underline">Task</NuxtLink><NuxtLink v-if="entry.discussionId" :to="'/channels/'+entry.discussionId" class="text-primary underline">Discussion</NuxtLink></div></article>
        <div v-if="auditQ.data.value&&auditQ.data.value.total>20" class="flex items-center gap-3"><UButton label="Previous" color="neutral" variant="outline" :disabled="page<=1" @click="page--" /><span class="text-sm">Page {{ page }}</span><UButton label="Next" color="neutral" variant="outline" :disabled="page*20>=auditQ.data.value.total" @click="page++" /></div>
      </template>
    </template>
    <UModal v-model:open="editorOpen" :title="editing?'Edit MCP connection':'Connect MCP source'" :dismissible="!busy">
      <template #body><form id="mcp-connection-form" class="space-y-4" @submit.prevent="save">
        <UAlert v-if="error" color="error" title="Connection was not saved" :description="error" />
        <UFormField label="Name" required><UInput v-model="form.name" aria-label="Connection name" maxlength="60" required class="w-full" /></UFormField>
        <UFormField label="Provider"><USelect v-model="form.providerId" :items="outboundMcpProviders.map(p=>({label:p.name,value:p.id}))" value-key="value" :disabled="Boolean(editing)" aria-label="MCP provider" class="w-full" /></UFormField>
        <UFormField label="Ownership"><USelect v-model="form.ownership" :items="settings?.mayManageServer?[{label:'Server-owned',value:'server'},{label:'Personal',value:'member'}]:[{label:'Personal',value:'member'}]" value-key="value" :disabled="Boolean(editing)" aria-label="Connection ownership" class="w-full" /></UFormField>
        <p class="text-sm text-muted">{{ form.ownership==='member'?'Only you can manage this connection. You must initiate its Runs; only explicitly selected Agents can use it.':'Select Agent and initiator grants. A selected Role can grant either side; both sides still need Use external tools.' }}</p>
        <UFormField label="Allowed Agents"><USelectMenu v-model="form.grants.agentIds" :items="agentOptions" value-key="value" multiple aria-label="Allowed Agents" class="w-full" /></UFormField>
        <template v-if="form.ownership==='server'">
          <UFormField label="Allowed initiating Members"><USelectMenu v-model="form.grants.memberIds" :items="memberOptions" value-key="value" multiple aria-label="Allowed initiating Members" class="w-full" /></UFormField>
          <UFormField label="Allowed Roles"><USelectMenu v-model="form.grants.roleIds" :items="roleOptions" value-key="value" multiple aria-label="Allowed Roles" class="w-full" /></UFormField>
        </template>
        <fieldset class="space-y-2"><legend class="mb-2 text-sm font-medium">Reviewed read-only tools</legend><UCheckbox v-for="name in provider.readTools" :key="name" :model-value="form.toolNames.includes(name)" :label="name" @update:model-value="value=>{form.toolNames=value?[...form.toolNames,name]:form.toolNames.filter(t=>t!==name)}" /></fieldset>
        <p class="text-sm text-muted">Saving disables the connection. Refresh tools, then enable it when ready. Saving, credential rotation or refreshing changes the revision: existing Runs must be restarted.</p>
        <UFormField label="Credential change"><USelect v-model="credentialAction" :items="[{label:editing&&connections.find(c=>c.id===editing)?.hasCredential?'Keep saved credential':'Public / no credential',value:'keep'},{label:'Set or replace bearer token',value:'replace'},{label:'Remove credential',value:'remove'}]" value-key="value" aria-label="Credential change" class="w-full" /></UFormField>
        <UFormField v-if="credentialAction==='replace'" label="Bearer token" required><UInput v-model="credential" type="password" autocomplete="new-password" aria-label="Bearer token" :required="credentialAction==='replace'" class="w-full" /></UFormField>
        <UFormField label="Credential expiry (ISO date/time)"><UInput v-model="expiry" aria-label="Credential expiry" placeholder="2026-12-31T23:59:59Z" class="w-full" /></UFormField>
        <p class="text-xs text-muted">Saved credentials are never displayed. Changing expiry requires a new token. Expired/revoked OAuth tokens require manual replacement; automatic OAuth authorization/refresh is unavailable.</p>
      </form></template>
      <template #footer><UButton label="Cancel" color="neutral" variant="outline" :disabled="Boolean(busy)" @click="editorOpen=false" /><UButton label="Save connection" type="submit" form="mcp-connection-form" :loading="busy==='save'" :disabled="!form.name.trim()||!form.toolNames.length" /></template>
    </UModal>
    <UModal :open="Boolean(removeTarget)" title="Revoke connection?" @update:open="value=>{if(!value)removeTarget=null}"><template #body><p class="text-sm text-muted">{{ removeTarget?.name }} will be removed. Active Runs lose access to subsequent calls and cached results.</p></template><template #footer><UButton label="Cancel" color="neutral" variant="outline" :disabled="Boolean(busy)" @click="removeTarget=null" /><UButton label="Revoke connection" color="error" :loading="Boolean(busy)" @click="remove" /></template></UModal>
  </div>
</template>
