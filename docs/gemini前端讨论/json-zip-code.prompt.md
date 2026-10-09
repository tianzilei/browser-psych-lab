请中文审查ZIP和图片container/header实现，结尾 ZIP_CODE_REVIEW_COMPLETE。用户要求服务器没有图像处理，不进行解码、缩放、转码，仅header/static校验和sha256。node24支持zlib crc32。ZIP upload8MiB worker maxexpanded32MiB single8MiB 100image/200entry拒路径/重复/symlink/加密，不使用用户路径落地，只UUID。全部校验后manifest包含UUID及哈希先写durable再publishExclusiveUUIDbytes，DB singlewriter internal.package.ready原子插入name+entry+READY assets，package同name拒绝覆盖，BACKUP复制所有READYassets+db。失败仅prevalidation删除temp且jobFAILED可重试，publish后IO异常RECOVERY_REQUIRED人工检查。保留旧资产上传API但同用此header，无sharpproduction。客户端Canvas真实decode+hash验证计时前既有prepare负责。请找实际边界bug，不建议服务端集成图像decoder，不要求对无法header查证的entropystream做处理；未能证明有效像素数据要明确限制。
代码：
import {inflateRawSync,crc32} from 'node:zlib';
import {imagePath} from '../shared/questionnaire-json.js';

// Header/container validation only. No decoder, resize or re-encoding on the server.
export function imageInfo(b:Buffer){
  let width=0,height=0,format:'png'|'jpeg'|'webp';
  if(b.length<24||b.length>8*1024*1024)throw new Error('INVALID_IMAGE_BYTES');
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    format='png';let pos=8,ended=false,hasData=false;
    while(pos+12<=b.length){const size=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8),end=pos+12+size;if(end>b.length)throw new Error('TRUNCATED_PNG');
      if(crc32(b.subarray(pos+4,end-4))!==b.readUInt32BE(end-4))throw new Error('PNG_CRC_MISMATCH');
      if(pos===8){if(type!=='IHDR'||size!==13)throw new Error('INVALID_PNG_HEADER');width=b.readUInt32BE(pos+8);height=b.readUInt32BE(pos+12);}
      if(type==='acTL'||type==='eXIf')throw new Error('STATIC_NORMALIZED_IMAGE_REQUIRED');
      if(type==='IDAT')hasData=true;
      if(type==='IEND'){if(size!==0||end!==b.length||!hasData)throw new Error('INVALID_PNG_END');ended=true;break;}pos=end;
    }if(!ended)throw new Error('TRUNCATED_PNG');
  }else if(b[0]===255&&b[1]===216){
    format='jpeg';let pos=2;const sof=[0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf];
    if(b.at(-2)!==255||b.at(-1)!==217)throw new Error('TRUNCATED_JPEG');
    while(pos+4<=b.length){if(b[pos++]!==255)throw new Error('INVALID_JPEG_MARKER');while(b[pos]===255)pos++;const marker=b[pos++]!;
      if(marker===0xda)break;if(marker===0xd8||marker===1||marker>=0xd0&&marker<=0xd7)continue;
      const size=b.readUInt16BE(pos);if(size<2||pos+size>b.length)throw new Error('TRUNCATED_JPEG');
      if(marker===0xe1&&b.toString('ascii',pos+2,pos+6)==='Exif')throw new Error('IMAGE_EXIF_NOT_ALLOWED');
      if(sof.includes(marker)){if(size<8)throw new Error('INVALID_JPEG_SOF');height=b.readUInt16BE(pos+3);width=b.readUInt16BE(pos+5);}pos+=size;
    }
  }else if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
    format='webp';if(b.readUInt32LE(4)+8!==b.length)throw new Error('TRUNCATED_WEBP');let pos=12;
    while(pos+8<=b.length){const type=b.toString('ascii',pos,pos+4),size=b.readUInt32LE(pos+4),start=pos+8,end=start+size;
      if(end>b.length)throw new Error('TRUNCATED_WEBP');
      if(type==='ANIM'||type==='ANMF'||type==='EXIF')throw new Error('STATIC_NORMALIZED_IMAGE_REQUIRED');
      if(type==='VP8X'){if(size!==10||(b[start]!&2))throw new Error('STATIC_IMAGE_REQUIRED');width=1+b.readUIntLE(start+4,3);height=1+b.readUIntLE(start+7,3);}
      if(type==='VP8 '){if(size<10||b.toString('hex',start+3,start+6)!=='9d012a')throw new Error('INVALID_WEBP');width=b.readUInt16LE(start+6)&0x3fff;height=b.readUInt16LE(start+8)&0x3fff;}
      if(type==='VP8L'){if(size<5||b[start]!==0x2f)throw new Error('INVALID_WEBP');const bits=b.readUInt32LE(start+1);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
      pos=end+(size&1);
    }if(pos!==b.length)throw new Error('TRUNCATED_WEBP');
  }else throw new Error('PNG_JPEG_WEBP_REQUIRED');
  if(!width||!height||width>4096||height>4096||width*height>4_000_000)throw new Error('IMAGE_PIXEL_BUDGET_EXCEEDED');
  return {width,height,format,validation:'container-header-v1'};
}
export function unpackImages(b:Buffer){
  if(b.length>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
  let eocd=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){eocd=i;break;}
  if(eocd<0||b.readUInt16LE(eocd+4)||b.readUInt16LE(eocd+6)||b.readUInt16LE(eocd+8)!==b.readUInt16LE(eocd+10))throw new Error('STANDARD_ZIP_REQUIRED');
  const count=b.readUInt16LE(eocd+10),central=b.readUInt32LE(eocd+16),size=b.readUInt32LE(eocd+12);
  if(!count||count>200||central+size!==eocd)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
  const images:{path:string;bytes:Buffer;info:ReturnType<typeof imageInfo>}[]=[],names=new Set<string>();let pos=central,total=0;
  for(let i=0;i<count;i++){
    if(pos+46>eocd||b.readUInt32LE(pos)!==0x02014b50)throw new Error('INVALID_ZIP_DIRECTORY');
    const flags=b.readUInt16LE(pos+8),method=b.readUInt16LE(pos+10),crc=b.readUInt32LE(pos+16),compressed=b.readUInt32LE(pos+20),expanded=b.readUInt32LE(pos+24),nameLen=b.readUInt16LE(pos+28),extra=b.readUInt16LE(pos+30),comment=b.readUInt16LE(pos+32),external=b.readUInt32LE(pos+38),local=b.readUInt32LE(pos+42);
    const next=pos+46+nameLen+extra+comment;if(next>eocd||flags&1||![0,8].includes(method)||b.readUInt16LE(pos+34)||((external>>>16)&0xf000)===0xa000)throw new Error('UNSUPPORTED_ZIP_ENTRY');
    const nameBytes=b.subarray(pos+46,pos+46+nameLen),name=nameBytes.toString('utf8');if(!Buffer.from(name).equals(nameBytes)||names.has(name))throw new Error('DUPLICATE_OR_INVALID_ZIP_PATH');names.add(name);
    const directory=name.endsWith('/');if(directory){if(name.slice(0,-1).split('/').some(p=>!p||p==='.'||p==='..'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p))||expanded!==0)throw new Error('INVALID_ZIP_PATH');}else imagePath(name);
    if(local+30>central||b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method)throw new Error('INVALID_ZIP_LOCAL_HEADER');
    const localName=b.readUInt16LE(local+26),localExtra=b.readUInt16LE(local+28),start=local+30+localName+localExtra;
    if(localName!==nameLen||!b.subarray(local+30,local+30+localName).equals(nameBytes)||start+compressed>central)throw new Error('INVALID_ZIP_LOCAL_HEADER');
    total+=expanded;if(expanded>8*1024*1024||total>32*1024*1024||images.length>=100&&!directory)throw new Error('ZIP_EXPANDED_BUDGET_EXCEEDED');
    const packed=b.subarray(start,start+compressed),bytes=method===0?packed:inflateRawSync(packed,{maxOutputLength:8*1024*1024});
    if(bytes.length!==expanded||crc32(bytes)!==crc)throw new Error('ZIP_CRC_OR_LENGTH_MISMATCH');
    if(!directory){const info=imageInfo(bytes),ext=name.split('.').at(-1)!.toLowerCase();if(info.format!==({jpg:'jpeg',jpeg:'jpeg',png:'png',webp:'webp'} as Record<string,string>)[ext])throw new Error('IMAGE_EXTENSION_MISMATCH');images.push({path:name,bytes,info});}pos=next;
  }if(pos!==eocd||!images.length)throw new Error('INVALID_ZIP_DIRECTORY');return images;
}
      if(headerless){
        // Only archives predating the queue contract may use their original GET.
        // Their pending requests still share the global FIFO stream budget.
        if(await assetPolicy.get(info.runner_hash)!=='legacy')throw new ContractError('PREPARATION_TICKET_REQUIRED',409);
        done=await preparation.legacyTransfer(id((request.params as {session:string}).session),connection.signal,cancel);
      }else{
        const nonce=id(request.headers['x-preparation-ticket']);
        const ready=await participant(request,'preparation',{writer_id:id(request.headers['x-writer-id']),writer_epoch:Number(request.headers['x-writer-epoch'])}) as {key:string;asset_ids:string[]};
        if(!ready.asset_ids.includes(asset))throw new ContractError('ASSET_FORBIDDEN',403);
        done=preparation.transfer(ready.key,nonce,cancel);
      }
      const file=await openPrivate(await assetPath(root,asset));stream=file.createReadStream();
      if(closed||reply.raw.destroyed){stream.destroy();done();throw new ContractError('PREPARATION_TICKET_EXPIRED',409);}stream.once('error',cancel);
      reply.type(`image/${info.format}`).header('ETag',`"${info.hash}"`).header('Cache-Control','private, no-store, no-transform');return reply.send(stream);
    }catch(error){done?.();throw error;}
  });
  app.get('/runners/:hash/*',async(request,reply)=>{
    const params=request.params as {hash:string;'*':string};if(!/^[a-f0-9]{64}$/.test(params.hash)||!params['*']||params['*'].split('/').some(p=>!p||p==='..'||! /^[a-zA-Z0-9._-]+$/.test(p)))throw new ContractError('INVALID_RUNNER_OBJECT',404);
    const path=join(root,'research-assets','runners',params.hash,params['*']),suffix=params['*'].split('.').at(-1);
    reply.type(suffix==='js'?'text/javascript':suffix==='css'?'text/css':suffix==='html'?'text/html':'application/json');
    reply.header('Vary','Accept-Encoding').header('Cache-Control',suffix==='html'?'no-cache, no-transform':'public, max-age=31536000, immutable, no-transform');
    for(const encoding of runnerEncodings(request.headers['accept-encoding'])){
      if(encoding!=='identity'&&!/^assets\/.*\.(js|css)$/.test(params['*']))continue;
      try{const file=await openPrivate(encoding==='identity'?path:`${path}.${encoding==='br'?'br':'gz'}`);
        if(encoding!=='identity')reply.header('Content-Encoding',encoding);
        reply.header('Content-Length',(await file.stat()).size);return reply.send(file.createReadStream());
      }catch(error){if(encoding==='identity'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    throw new ContractError('ENCODING_NOT_ACCEPTABLE',406);
  });
}
    const temporary=join(config.root,'research-assets','.tmp');let removed=0;try{for(const name of await readdir(temporary))if(name.startsWith(`${id(config.config.asset_id)}-`)){const file=await openPrivate(join(temporary,name));await file.close();await unlink(join(temporary,name));removed++;}await syncDirectory(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await syncDirectory(dirname(path));return {asset_id:config.config.asset_id,purged:true,temporary_removed:removed};
  }
  const db=new Database(config.path,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  try{
    if(config.kind==='REPLAY'){
      db.exec('BEGIN');const sid=id(config.config.session_id),scope=id(config.config.scope);const started=Date.now();
      const permit=db.prepare('SELECT plan FROM lab_permits WHERE session_id=? AND scope=?').get(sid,scope) as {plan:string}|undefined;
      if(!permit)throw new Error('PERMIT_NOT_FOUND');
      const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,scope);
      const replay=new RunReplay(JSON.parse(permit.plan) as GroupPlan);let count=0;
      for(const row of db.prepare('SELECT envelope,disposition FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').iterate(sid,scope) as Iterable<{envelope:string;disposition:string}>){
        if(++count>5000||Date.now()-started>30000||row.disposition!=='ACCEPTED')throw new Error('REPLAY_INPUT_OR_BUDGET_INVALID');
        const e=parseLabEvent(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);
      }
      const results=replay.finish();db.exec('COMMIT');return {session_id:sid,scope,source_hash:digest(stableJSON(refs)),valid:true,algorithm:'run-replay-v1',results};
    }
    if(config.kind==='REBUILD'){
      db.exec('BEGIN');const study=id(config.config.study_id),projections:unknown[]=[];const started=Date.now();
      for(const p of db.prepare("SELECT p.session_id,p.scope,p.plan FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND p.state='CLOSED_NORMAL'").iterate(study) as Iterable<{session_id:string;scope:string;plan:string}>){
        if(projections.length>=1000||Date.now()-started>30000)throw new Error('REBUILD_BUDGET_EXCEEDED');const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(p.session_id,p.scope);const replay=new RunReplay(JSON.parse(p.plan));
        for(const row of db.prepare('SELECT envelope,disposition FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').iterate(p.session_id,p.scope) as Iterable<{envelope:string;disposition:string}>){if(row.disposition!=='ACCEPTED')throw new Error('REBUILD_INPUT_INVALID');const e=parseLabEvent(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);}
        projections.push({session_id:p.session_id,scope:p.scope,source_hash:digest(stableJSON(refs)),result:replay.finish()});if(Buffer.byteLength(stableJSON(projections))>4*1024*1024)throw new Error('REBUILD_RESULT_BUDGET_EXCEEDED');
      }db.exec('COMMIT');return {generation_id:config.job,projections,algorithm:'run-replay-v1'};
    }
