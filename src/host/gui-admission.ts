/** Resolve trusted per-session locations; never use the Desktop backend's own cwd as a workspace. */
import {isAbsolute} from 'node:path'
import {CoordinationError} from '../errors.ts'
import {resolveProject} from '../identity.ts'
import type {HostSessionAdmission} from './persistence.ts'
import type {GuiStateRootsGuard} from './gui-state-roots.ts'
export function createGuiSessionAdmission(guard:GuiStateRootsGuard):(request:HostSessionAdmission)=>void {
  return request=>{
    const cwd=request.header.cwd
    if(typeof cwd!=='string'||!isAbsolute(cwd))throw new CoordinationError('UNMEDIATED_WRITE_DENIED','GUI session admission requires an explicit absolute project directory from the trusted host session header. Choose a project folder; the application/profile directory is not a fallback workspace.')
    const project=resolveProject(cwd,request.workspaceRoot)
    guard.assertSessionAllowed({cwd,workspace_root:project.root})
  }
}
