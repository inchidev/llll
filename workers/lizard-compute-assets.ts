import daemon from '../packages/compute-node/src/daemon.mjs?raw'
import diskStore from '../packages/compute-node/src/disk-store.mjs?raw'
import stateStore from '../packages/compute-node/src/state-store.mjs?raw'
import process from '../packages/compute-node/src/process.mjs?raw'
import operate from '../packages/compute-node/src/operate.mjs?raw'
import proxy from '../packages/compute-node/src/proxy.mjs?raw'
import fetchSource from '../packages/compute-node/src/fetch-source.mjs?raw'
import cloudIo from '../packages/compute-node/src/cloud-io.mjs?raw'
import relay from '../packages/compute-node/src/lizard-relay.mjs?raw'
import dockerfile from '../packages/compute-node/Dockerfile.workspace?raw'
/** Fixed Server-owned bootstrap assets, bundled with the Server release. */
export const lizardComputeAssets: Record<string, string> = {
  'src/daemon.mjs': daemon,
  'src/disk-store.mjs': diskStore,
  'src/state-store.mjs': stateStore,
  'src/process.mjs': process,
  'src/operate.mjs': operate,
  'src/proxy.mjs': proxy,
  'src/fetch-source.mjs': fetchSource,
  'src/cloud-io.mjs': cloudIo,
  'src/lizard-relay.mjs': relay,
  'Dockerfile.workspace': dockerfile,
}
