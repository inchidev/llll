import { mkdir,chmod,chown,lstat,readdir,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { runProcess } from './process.mjs'

/** Trusted Linux broker only. Each mounted filesystem has a fixed allocated block capacity. */
export class LoopDiskStore {
  constructor(root,{bytes=10737418240,maxDisks=4,runner=runProcess,ownerUid=1000,ownerGid=1000}={}) {
    this.root=resolve(root);this.bytes=bytes;this.maxDisks=maxDisks;this.runner=runner;this.ownerUid=ownerUid;this.ownerGid=ownerGid
  }
  paths(id) {
    if(!/^[a-f0-9-]{36}$/u.test(id))throw new Error('Invalid disk identity')
    return {image:join(this.root,id+'.img'),mount:join(this.root,id)}
  }
  async command(name,args) {
    const result=await this.runner(name,args,{timeoutMs:30000,limit:4000})
    if(result.code!==0) {
      if (/no space left on device|disk quota exceeded/iu.test(result.stderr.toString())) throw new Error('Compute Node disk is full; free space or move Task storage to a larger disk')
      throw new Error('Linux disk operation failed; configure loop devices, mount permissions and free capacity')
    }
    return result.stdout.toString().trim()
  }
  async initialize() {
    if(process.getuid()!==0)throw new Error('Hard-quota Compute Node needs a trusted root service with Linux loop/mount access; no disk-quota fallback is used')
    await mkdir(this.root,{recursive:true,mode:0o700});await chmod(this.root,0o700)
    for(const command of ['fallocate','mkfs.ext4','mount','umount','findmnt','losetup','sync'])await this.command(command,['--version']).catch(async error=>{
      if(command==='mkfs.ext4')await this.command(command,['-V']);else throw error
    })
  }
  async mounted(id) {
    const paths=this.paths(id),result=await this.runner('findmnt',['-rn','--mountpoint',paths.mount,'--output','SOURCE'],{timeoutMs:1000,limit:2000})
    if(result.code!==0)return false
    const devices=(await this.command('losetup',['--list','--noheadings','--output','NAME','--associated',paths.image])).split(/\s/u).filter(Boolean)
    if(!devices.includes(result.stdout.toString().trim()))throw new Error('Foreign filesystem mounted at workspace disk path')
    return true
  }
  async ensure(id,create=false) {
    const paths=this.paths(id)
    let exists=false
    try{const stat=await lstat(paths.image);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.bytes)throw new Error('Invalid workspace disk');exists=true}catch(error){if(error.code!=='ENOENT')throw error}
    if(!exists){
      if(!create)throw new Error('Persistent workspace disk is unavailable')
      if((await readdir(this.root)).filter(name=>name.endsWith('.img')).length>=this.maxDisks)throw new Error('Node disk capacity is occupied; release an existing Task disk')
      try{
        await this.command('fallocate',['--length',String(this.bytes),paths.image]);await chmod(paths.image,0o600)
        await this.command('mkfs.ext4',['-q','-F','-E','nodiscard',paths.image])
      }catch(error){await rm(paths.image,{force:true});throw error}
    }
    await mkdir(paths.mount,{recursive:true,mode:0o700})
    if((await lstat(paths.mount)).isSymbolicLink())throw new Error('Unsafe disk mount directory')
    if(!await this.mounted(id))await this.command('mount',['-o','loop,nodev,nosuid',paths.image,paths.mount])
    if(!await this.mounted(id))throw new Error('Workspace disk mount could not be verified')
    await chown(paths.mount,this.ownerUid,this.ownerGid);await chmod(paths.mount,0o700)
    return paths.mount
  }
  async remove(id) {
    const paths=this.paths(id)
    if(await this.mounted(id))await this.command('umount',[paths.mount])
    await rm(paths.mount,{recursive:true,force:true});await rm(paths.image,{force:true})
  }
  async cleanup() {
    for(const name of await readdir(this.root))if(/^[a-f0-9-]{36}\.img$/u.test(name))await this.remove(name.slice(0,-4))
  }
}
