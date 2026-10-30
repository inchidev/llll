import { chmod } from 'node:fs/promises'
import { runProcess } from './process.mjs'

// This process belongs to the trusted source broker, in its own bounded container.
// It never runs a model, checks out source, loads repository hooks or writes a credential file.
try {
  const chunks=[];let size=0
  for await(const chunk of process.stdin){size+=chunk.length;if(size>10000)throw new Error('Source request limit');chunks.push(chunk)}
  const {repository,baseSha,token,remote,authorization}=JSON.parse(Buffer.concat(chunks).toString())
  // GitHub: a single-repository read token. Otherwise the Server's own read-only source address and capability.
  const brokered=typeof remote==='string'
  if(!/^[a-f0-9]{40}$/u.test(baseSha))throw new Error('Invalid source request')
  if(brokered?!(/^https:\/\/[^/@]+\/api\/compute-agent\/source\/[a-f0-9-]{36}\.git$/u.test(remote)&&/^Bearer [a-f0-9]{64}$/u.test(authorization)):!(/^[\w.-]+\/[\w.-]+$/u.test(repository)&&typeof token==='string'))throw new Error('Invalid source request')
  const url=brokered?remote:`https://github.com/${repository}.git`
  const env={PATH:process.env.PATH,HOME:'/tmp',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/bin/false',
    GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:brokered?`http.${new URL(remote).origin}/.extraheader`:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:brokered?'AUTHORIZATION: '+authorization:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64'),
    GIT_CONFIG_KEY_1:'http.followRedirects',GIT_CONFIG_VALUE_1:'false',GIT_CONFIG_KEY_2:'http.lowSpeedLimit',GIT_CONFIG_VALUE_2:'1024',GIT_CONFIG_KEY_3:'http.lowSpeedTime',GIT_CONFIG_VALUE_3:'15',
    ...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','GIT_SSL_CAINFO'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))}
  const git=async args=>{const result=await runProcess('git',['-c','core.hooksPath=/dev/null',...args],{cwd:'/source',env,timeoutMs:120000,limit:10000});if(result.code!==0)throw new Error('Pinned source fetch failed')}
  await git(['init','--bare','repo.git'])
  await git(['-C','repo.git','fetch','--no-tags',url,baseSha])
  await git(['-C','repo.git','update-ref','refs/heads/source',baseSha])
  await git(['-C','repo.git','bundle','create','/source/source.bundle','--all'])
  await chmod('/source/source.bundle',0o444)
  process.stdout.write(JSON.stringify({ok:true}))
}catch{process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1}
