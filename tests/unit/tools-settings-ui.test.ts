// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref, reactive, watch } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import Tools from '../../app/components/settings/ToolsSettings.vue'
import SettingsList from '../../app/components/settings/SettingsList.vue'
import { ids } from '../helpers/outbound-mcp'
afterEach(()=>vi.unstubAllGlobals())
async function setup(mayConnect=true){
 const calls:Array<{path:string;options?:{method?:string;body?:unknown}}>=[]
 const api=vi.fn(async(path:string,options?:{method?:string;body?:unknown})=>{
  calls.push({path,options})
  if(options?.method==='PUT'||options?.method==='POST')throw Error('Safe validation error')
  if(path.endsWith('/tools'))return {agents:[{id:ids.agent,name:'Research Agent',roleId:ids.agentRole,status:'active'}],members:[],roles:[],mayConnect,mayManageServer:false,mayPreview:true,mayAudit:mayConnect,capabilities:[]}
  return {connections:[{id:'connection',name:'Personal docs',providerId:'cloudflare-docs',ownership:'member',enabled:false,revision:1,grants:{agentIds:[ids.agent],memberIds:[],roleIds:[]},toolNames:['search_cloudflare_documentation'],tools:[],hasCredential:true,credentialExpiresAt:null,checkedAt:null,lastError:null}]}
 })
 for(const[name,value]of Object.entries({computed,ref,reactive,watch,useApi:()=>({api}),useToast:()=>({add:vi.fn()}),useRoleGrants:()=>({can:()=>false}),errorMessage:(e:Error)=>e.message}))vi.stubGlobal(name,value)
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 const view=mount(Tools,{props:{serverId:ids.server},global:{components:{SettingsList},plugins:[[VueQueryPlugin,{queryClient:client}]],stubs:{
  UButton:{props:['label','disabled'],template:'<button :disabled="disabled">{{label}}</button>'},
  UModal:{props:['open'],template:'<div v-if="open"><slot name="body"/><slot name="footer"/></div>'},
  UInput:{props:['modelValue','type'],emits:['update:modelValue'],template:'<input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)"/>'},
  USelect:{props:['modelValue','items'],emits:['update:modelValue'],template:'<select :value="modelValue" @change="$emit(\'update:modelValue\',$event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{item.label}}</option></select>'},
  USelectMenu:true,UCheckbox:true,UIcon:true,LayoutSegmentedTabs:true,UFormField:{template:'<label><slot/></label>'},UAlert:{props:['title','description'],template:'<div>{{title}} {{description}}</div>'},UBadge:true,LayoutSkeleton:true,LayoutLoadError:true,NuxtLink:true,
 }}})
 await flushPromises()
 return {view,client,calls}
}
it('keeps saved credentials hidden and clears replacement text after a rejected save',async()=>{
 const {view,client,calls}=await setup()
 try{
  await view.findAll('button').find(b=>b.text().includes('Personal docs'))!.trigger('click');await flushPromises()
  expect(view.text()).toContain('Credential saved (hidden)')
  await view.findAll('button').find(b=>b.text()==='Edit connection')!.trigger('click');await flushPromises()
  expect(view.findAll('select[aria-label="Connection ownership"] option').map(o=>o.attributes('value'))).toEqual(['member'])
  await view.get('select[aria-label="Credential change"]').setValue('replace')
  await view.get('input[aria-label="Bearer token"]').setValue('synthetic-new-secret')
  await view.get('form').trigger('submit');await flushPromises()
  const request=calls.find(c=>c.options?.method==='PUT')!
  expect(request.options?.body).toMatchObject({credential:'synthetic-new-secret',ownership:'member',enabled:false,grants:{agentIds:[ids.agent],memberIds:[],roleIds:[]}})
  expect((view.get('input[aria-label="Bearer token"]').element as HTMLInputElement).value).toBe('')
  expect(view.text()).not.toContain('synthetic-new-secret')
  expect(view.text()).toContain('Safe validation error')
 }finally{view.unmount();client.clear()}
})
it('does not fetch restricted connections when the current Role lacks the external-tools grant',async()=>{
 const {view,client,calls}=await setup(false)
 try{expect(calls.some(c=>c.path.endsWith('/tool-connections'))).toBe(false);expect(view.text()).not.toContain('Personal docs');expect(view.text()).toContain('Your Role needs Use external tools')}
 finally{view.unmount();client.clear()}
})
