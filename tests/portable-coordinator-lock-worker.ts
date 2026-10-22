/** Child-process election fixture only. No transport server or daemon startup. */
import {InstanceLock} from '../src/instance-lock.ts'
const directory=process.argv[2]!,mode=process.argv[3]??'try'
try {
 const lock=await InstanceLock.acquire(directory)
 process.stdout.write('held\n')
 if(mode==='hold'){
   process.stdin.resume()
   process.stdin.once('data',()=>{void lock.close().then(()=>process.exit(0))})
 }else await lock.close()
}catch(error){
 process.stdout.write(JSON.stringify({code:(error as {code?:string}).code})+'\n');process.exitCode=2
}
