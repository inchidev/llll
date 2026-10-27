import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'

const operations = new Set(['/api/compute-agent/pair', '/api/compute-agent/poll'])
function authenticated(value, secret) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return false
  return timingSafeEqual(Buffer.from(value), Buffer.from(secret))
}
async function body(req, limit) {
  const chunks=[];let size=0
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('Request too large');chunks.push(chunk)}
  return Buffer.concat(chunks).toString('utf8')
}
/** Lizard-side bridge. The Server polls over Lizard's authenticated port; no Server port is exposed. */
export function createLizardRelay(secret, { timeoutMs=14000, maxPending=4 }={}) {
  if (!/^[a-f0-9]{64}$/u.test(secret ?? '')) throw Error('A random relay capability is required')
  const queue=[],pending=new Map()
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.url==='/bridge/next'&&req.method==='GET'){
        if(!authenticated(req.headers['x-relay-key'],secret)){res.writeHead(403).end();return}
        let item
        do {item=queue.shift()} while(item&&!pending.has(item.id))
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(item??null));return
      }
      if(req.url==='/bridge/respond'&&req.method==='POST'){
        if(!authenticated(req.headers['x-relay-key'],secret)){res.writeHead(403).end();return}
        const reply=JSON.parse(await body(req,600000))
        if(typeof reply.id!=='string'||!Number.isInteger(reply.status)||reply.status<200||reply.status>599||typeof reply.body!=='string') {res.writeHead(400).end();return}
        const target=pending.get(reply.id)
        if(!target){res.writeHead(404).end();return}
        pending.delete(reply.id);clearTimeout(target.timer)
        target.res.writeHead(reply.status,{'content-type':'application/json','cache-control':'no-store'}).end(reply.body)
        res.writeHead(204).end();return
      }
      if(req.method!=='POST'||!operations.has(req.url)||req.socket.remoteAddress!=='127.0.0.1'){res.writeHead(404).end();return}
      if(pending.size>=maxPending){res.writeHead(429).end();return}
      const data=await body(req,500000),id=randomUUID()
      const timer=setTimeout(()=>{pending.delete(id);if(!res.destroyed)res.writeHead(504).end()},timeoutMs)
      pending.set(id,{res,timer});queue.push({id,path:req.url,authorization:req.headers.authorization??null,body:data})
      res.on('close',()=>{const item=pending.get(id);if(item){clearTimeout(item.timer);pending.delete(id)}})
    } catch {if(!res.headersSent)res.writeHead(400);res.end()}
  })
  server.on('close',()=>{for(const {res,timer} of pending.values()){clearTimeout(timer);if(!res.destroyed)res.destroy()}pending.clear()})
  return server
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  createLizardRelay(process.env.LLLL_RELAY_KEY).listen(3900,'0.0.0.0')
}
