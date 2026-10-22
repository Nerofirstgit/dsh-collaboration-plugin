/** Private service process launched by the plugin. Never a public Harness application entrypoint. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startCoordinator } from './server.ts'
import { resolveConfig } from './config.ts'
import type { Config } from './types.ts'
import { record,string } from './util.ts'
async function main():Promise<void> {
  const directory=process.argv[2];if(!directory)throw new Error('Private daemon requires its managed data directory.')
  const value=record(JSON.parse(readFileSync(join(directory,'config.json'),'utf8')))
  const config=resolveConfig(value as Partial<Config>);if(config.data_dir!==directory)throw new Error('Coordinator configuration path mismatch.')
  const token=string(readFileSync(join(directory,'runtime.key'),'utf8').trim(),'runtime key')
  const server=await startCoordinator(config,token)
  let stopped=false
  const shutdown=()=>{if(stopped)return;stopped=true;void server.close().then(()=>{process.exitCode=0},error=>{process.stderr.write(String(error)+'\n');process.exitCode=1})}
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
  process.send?.({ready:true,socket_path:server.socket_path})
}
void main().catch(error=>{process.stderr.write(String(error)+'\n');process.exitCode=1})
