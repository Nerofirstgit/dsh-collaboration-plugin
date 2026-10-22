/**
 * Detached, exact Loader inventory for component composition tests only.
 * Uses real Loader, installed package manifests and protected providers, but it
 * deliberately does not activate every configured entry. This is not a live
 * installed-profile boot or transport acceptance substitute.
 */
import {mkdirSync,symlinkSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {Context} from '@deepseek-ai/cordis'
import {Loader,Entry,EntryTree} from '@deepseek-ai/cordis-plugin-loader'
import {PluginPackages} from '@deepseek-ai/dsh-app-boot'
import {ProtectedFileSystem} from '../../src/host/filesystem.ts'
import {ALLOWED_PROFILE_ENTRIES} from '../../src/host/profile.ts'

export async function installDetachedAuditedInventory(ctx:Context,dir:string,workspaceRoot:string):Promise<void>{
  mkdirSync(join(dir,'node_modules','@nerofirstgit'),{recursive:true})
  symlinkSync(resolve('node_modules/@deepseek-ai'),join(dir,'node_modules','@deepseek-ai'),process.platform==='win32'?'junction':'dir')
  symlinkSync(resolve('.'),join(dir,'node_modules','@nerofirstgit','dsh-collaboration'),process.platform==='win32'?'junction':'dir')
  ctx.baseUrl=pathToFileURL(join(dir,'anchor.js')).href
  await ctx.plugin(Loader,{baseUrl:ctx.baseUrl});await ctx.plugin(PluginPackages)
  await ctx.plugin(ProtectedFileSystem,{cwd:workspaceRoot})
  class DetachedTree extends EntryTree{write(){}}
  const include=new Entry(ctx.loader);include.options={id:'include',name:'cordis:include'};include.parent=ctx.loader.root
  const tree=new DetachedTree(ctx);include.subtree=tree;ctx.loader.store.include=include
  for(const [id,name]of Object.entries(ALLOWED_PROFILE_ENTRIES)){
    const entry=new Entry(ctx.loader)
    entry.options={id,name,
      config:id==='tools'?{mode:'native'}:id==='agent-loop'?{agents:[]}:id==='session-query-sqlite'?{path:':memory:',openAt:'never'}:{},
      inject:id==='agent-loop'?['sessionPersistence','collaborationReady']:id==='headless-runner'?['headlessStartup','collaborationReady']:undefined,
    }
    entry.parent=tree.root;tree.store[id]=entry
  }
}
