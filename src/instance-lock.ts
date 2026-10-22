import {SqliteElectionLock} from './platform/election.ts'
import {machineInstanceDirectory} from './config.ts'

/** The coordinator itself holds a SQLite write transaction for its lifetime. */
export class InstanceLock {
  private constructor(private readonly election:SqliteElectionLock){}
  static async acquire(directory:string):Promise<InstanceLock>{
    return new InstanceLock(SqliteElectionLock.acquire(directory,'coordinator-election.sqlite'))
  }
  async close():Promise<void>{this.election.close()}
}
/**
 * One cooperating coordinator per OS account, even across configured domains.
 * The optional namespace is an INTERNAL dependency-injection seam; no profile,
 * RPC, environment variable or Config field controls production election scope.
 */
export class CoordinatorInstanceLock {
  private constructor(private readonly machine:InstanceLock,private readonly domain:InstanceLock){}
  static async acquire(dataDirectory:string,internalNamespace=machineInstanceDirectory()):Promise<CoordinatorInstanceLock>{
    const machine=await InstanceLock.acquire(internalNamespace)
    try{return new CoordinatorInstanceLock(machine,await InstanceLock.acquire(dataDirectory))}
    catch(error){await machine.close();throw error}
  }
  async close():Promise<void>{try{await this.domain.close()}finally{await this.machine.close()}}
}
