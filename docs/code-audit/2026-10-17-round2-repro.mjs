// Converted after repair: passing verifies the correct behavior. The original
// defect evidence remains in 2026-10-17-round2-repro.log.
// Run npm run build first; the integration tests own their temporary Vite server.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const env={...process.env};delete env.NODE_TEST_CONTEXT;
for(const files of [['tests/unit/logic-round2.test.mjs','tests/unit/runner-release.test.mjs'],['tests/integration/logic-round2.test.mjs']]){
  const result=spawnSync(process.execPath,['--import','tsx','--test',...files],{cwd:root,stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
