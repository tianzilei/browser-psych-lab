import {build} from 'vite';
await build({configFile:false,publicDir:false,logLevel:'warn',build:{outDir:'dist/server/offline',emptyOutDir:true,minify:true,sourcemap:false,lib:{entry:'src/web/offline-replay.ts',name:'offlineReplay',formats:['iife'],fileName:()=>'offline-replay.js'}}});
