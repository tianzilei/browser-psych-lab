import Database from 'better-sqlite3';
import {loadEnv} from './lib.mjs';
import {cleanLightExports} from './lib/light-export-cleanup.mjs';
loadEnv();
const args=process.argv.slice(2);
if(args.some(arg=>!['--apply','--all'].includes(arg)))throw new Error('UNKNOWN_ARGUMENT');
if(!process.env.DATABASE_PATH||!process.env.STORAGE_ROOT)throw new Error('DATABASE_AND_STORAGE_REQUIRED');
const db=new Database(process.env.DATABASE_PATH,{fileMustExist:true});
db.pragma('busy_timeout=5000');
try{console.log(JSON.stringify(await cleanLightExports(db,process.env.STORAGE_ROOT,{apply:args.includes('--apply'),retentionMs:args.includes('--all')?0:86400000})));}
finally{db.close();}
