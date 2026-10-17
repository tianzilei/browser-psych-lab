// Converted on 2026-10-17: passing now verifies the repaired behavior.
// Run `npm run build` first. The browser test owns its isolated test server.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
function run(args){
  const result=spawnSync(process.execPath,args,{cwd:projectRoot,stdio:'inherit',env:childEnv});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
run(['--import','tsx','--test','tests/unit/logic-regressions.test.mjs']);
const output=mkdtempSync(join(tmpdir(),'bpl-logic-regressions-'));
run(['node_modules/@playwright/test/cli.js','test','tests/browser/lab.spec.ts','--grep','cross-version reanswer','--output',output]);
rmSync(output,{recursive:true,force:true});
