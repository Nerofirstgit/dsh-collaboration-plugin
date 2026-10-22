/** Instance-local human session placement guard for the pinned stock provider. */
import {Context,symbols} from '@deepseek-ai/cordis'
import SessionController,{type SessionCreateRequest,type SessionCreateValue} from '@deepseek-ai/dsh-api-session-controller'
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import {CoordinationError} from '../errors.ts'
import type {CollaborationReadiness} from './readiness.ts'

export interface GuiControllerReadiness {readonly ready:true}
declare module '@deepseek-ai/cordis' {interface Context {collaborationGuiControllerReady:GuiControllerReadiness}}

type Create=SessionController['create']
interface GuardRecord {
  active:boolean
  readonly original:Create
  readonly wrapper:Create
  readonly readiness:CollaborationReadiness
  readonly gui:NonNullable<CollaborationReadiness['gui']>
  readonly preflight:NonNullable<CollaborationReadiness['gui']>['assertWorkspacePathAllowed']
  readonly capability:GuiControllerReadiness
}
const records=new WeakMap<SessionController,GuardRecord>()
function refuse(reason:string):never {throw new CoordinationError('UNMEDIATED_WRITE_DENIED',`GUI controller admission: ${reason}`)}
function originalOf(value:unknown):unknown {
  if(typeof value!=='object'||value===null)return value
  return Reflect.get(value,symbols.original)??value
}
function controllerOf(ctx:Context):SessionController {
  const controller=originalOf(ctx.get('sessionController'))
  if(!(controller instanceof SessionController)||Object.getPrototypeOf(controller)!==SessionController.prototype){
    refuse('the actual pinned stock SessionController instance is required')
  }
  return controller
}
function guiReadiness(ctx:Context):CollaborationReadiness & {gui:NonNullable<CollaborationReadiness['gui']>} {
  const ready=ctx.get('collaborationReady')
  if(ready?.ready!==true||!ready.gui||typeof ready.gui.assertWorkspacePathAllowed!=='function'){
    refuse('workspace admission is not ready; start the reviewed collaboration GUI profile')
  }
  return ready as CollaborationReadiness & {gui:NonNullable<CollaborationReadiness['gui']>}
}

/** Exact live proof; a free-standing readiness boolean is never sufficient. */
export function assertGuiSessionControllerGuard(ctx:Context):void {
  const controller=controllerOf(ctx),record=records.get(controller)
  if(!record?.active||controller.create!==record.wrapper)refuse('the current stock controller is not guarded')
  const ready=guiReadiness(ctx)
  if(ready!==record.readiness||ready.gui!==record.gui||ready.gui.assertWorkspacePathAllowed!==record.preflight||
    ctx.get('collaborationGuiControllerReady')!==record.capability)refuse('the controller guard readiness changed')
}

function selectedPath(ctx:Context,request:SessionCreateRequest):string {
  // Match stock commands.ts:111-126 validation order and error vocabulary.
  if(request.workspaceId!==undefined&&request.cwd!==undefined){
    throw new RemoteError('gateway/bad-request','session.create accepts workspaceId or cwd, not both',{})
  }
  let path=request.cwd
  if(request.workspaceId!==undefined){
    const workspace=ctx.workspaceRegistry.get(request.workspaceId)
    if(workspace===undefined)throw new RemoteError('workspace/not-found',`workspace "${request.workspaceId}" not found`,{workspaceId:request.workspaceId})
    path=workspace.path
  }
  if(path===undefined){
    throw new RemoteError('gateway/bad-request','Choose a project folder before creating a collaboration session (workspaceId or absolute cwd).',{})
  }
  return path
}

/**
 * Pinned 687f282e packages/api/session-controller/src/index.ts:300 delegates
 * create to stock commands; agent.ts:563-579 mkdir runs before persistence.
 * api/gateway/src/index.ts:838-844 resolves the LIVE receiver method, then
 * invokes it with that receiver (407-422). Cordis 4.0.5 symbols.original unwraps
 * its context-view proxy for identity checks, while we preserve the live `this`
 * during delegation. Strict schemas and browser client metadata remain stock.
 *
 * Only this instance is changed, never the prototype, package or disk. On
 * teardown its retained wrapper closes rather than briefly exposing raw create.
 * A full profile stop/cold restart restores ordinary stock mode with a fresh
 * untouched controller. Known inactive instances can reinstall without nesting.
 */
export function installGuiSessionControllerGuard(ctx:Context):void {
  const controller=controllerOf(ctx),previous=records.get(controller),readiness=guiReadiness(ctx)
  if(previous?.active)refuse('a guard is already active on this controller')
  if(controller.create!==(previous?.wrapper??SessionController.prototype.create))refuse('the stock create implementation changed')
  const original=previous?.original??controller.create
  const capability:GuiControllerReadiness=Object.freeze({ready:true})
  const record:GuardRecord={active:true,original,readiness,gui:readiness.gui,preflight:readiness.gui.assertWorkspacePathAllowed,capability,
    wrapper:async function(this:SessionController,request:SessionCreateRequest):Promise<SessionCreateValue>{
      if(!record.active||originalOf(this)!==controller)refuse('the controller guard is inactive or the receiver changed')
      assertGuiSessionControllerGuard(this.ctx)
      record.preflight.call(record.gui,selectedPath(this.ctx,request))
      // No await before stock delegation, and no request rewriting. The pinned
      // implementation retains blank reuse, workspace attach and preset logic.
      return Reflect.apply(record.original,this,[request])
    }}
  Object.defineProperty(controller,'create',{value:record.wrapper,writable:false,enumerable:false,configurable:true})
  records.set(controller,record)
  try {
    ctx.effect(()=>()=>{record.active=false})
    ctx.provide('collaborationGuiControllerReady',capability)
  } catch(error) {record.active=false;throw error}
}

export const inject=['sessionController','collaborationReady']
export const apply=installGuiSessionControllerGuard
export default {name:'collaboration-gui-controller-guard',inject,apply}
