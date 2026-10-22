/** Filesystem/bootstrap preparation only; never invokes connectCoordinator. */
import {preparePrivateState} from '../src/bootstrap.ts'
import {resolveConfig} from '../src/config.ts'
const result=preparePrivateState(resolveConfig({data_dir:process.argv[2]!}))
process.stdout.write(JSON.stringify(result)+'\n')
