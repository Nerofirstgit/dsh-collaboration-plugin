/** Runtime-only service published after profile and coordinator admission, never a model capability. */
export interface CollaborationReadiness {
  readonly ready:true
  readonly gui?:{
    readonly state_fingerprint:string
    /** Human GUI workspace setup preflight; does not create a directory or grant file writes. */
    assertWorkspacePathAllowed(path:string):string
  }
}
declare module '@deepseek-ai/cordis' {interface Context {collaborationReady:CollaborationReadiness}}
