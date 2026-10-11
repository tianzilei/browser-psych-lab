全项目设计讨论，传输段 48，源码主题：运维工具和部署（源包 15/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

      if(typeof variant.name!=='string'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(variant.name))throw new Error('INVALID_VARIANT_NAME');
      if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(variant.name))throw new Error('RESERVED_DEVICE_NAME');
      const {name,...overrides}=variant,settings={...defaults,...options(overrides)};
      validateVariantOptions(settings);
      const ext=settings.format==='jpeg'?'jpg':settings.format??'webp';
      // Reserve all possible tile paths before work, including cross-variant
      // names such as foo(tile) versus foo-tile-001(single).
      for(let i=1;i<=(settings.tiles?100:1);i++){
        const path=`images/${name}${settings.tiles?`-tile-${String(i).padStart(3,'0')}`:''}.${ext}`.toLowerCase();
        if(plannedPaths.has(path))throw new Error('DUPLICATE_PLANNED_IMAGE_PATH');plannedPaths.add(path);
      }
      planned.push({source:item.source,name,settings});
    }
  }
  const sources=new Map();
  for(const entry of planned){
    const path=await realpath(resolve(dirname(configPath),entry.source));
    if(!sources.has(path))sources.set(path,[]);sources.get(path).push(entry);
  }
  const files=[],reports=[],names=new Set();let packageBytes=0;
  for(const [sourcePath,entries] of sources){
    const st=await stat(sourcePath);if(!st.isFile()||st.size>32*1024*1024)throw new Error('SOURCE_BYTE_LIMIT_EXCEEDED');
    const input=await readFile(sourcePath);
    for(const {source,name,settings} of entries){
      const result=await optimizeImage(input,settings);
      for(const [i,output] of result.outputs.entries()){
        const ext=settings.format==='jpeg'?'jpg':settings.format??'webp';
        const path=`images/${name}${settings.tiles?`-tile-${String(i+1).padStart(3,'0')}`:''}.${ext}`;
        const key=path.toLowerCase();if(names.has(key))throw new Error('DUPLICATE_IMAGE_PATH');names.add(key);
        packageBytes+=output.bytes.length;if(packageBytes>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
        files.push({path,bytes:output.bytes});if(files.length>100)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
        reports.push({path,source,sourceInfo:result.source,settings,...output.report});
      }
    }
  }
  const zip=packImageZip(files),output=resolve(args[1]);
  const report={schema:'mobile-images-report-v1',package:config.package,packageBytes:zip.length,sourceReads:sources.size,images:reports};
  await publishImageOutput(output,async staging=>{
    await mkdir(join(staging,'images'));
    for(const file of files)await writeFile(join(staging,file.path),file.bytes,{flag:'wx'});
    await writeFile(join(staging,config.package),zip,{flag:'wx'});
    await writeFile(join(staging,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  });
  const warnings=reports.filter(r=>r.budgetExceeded).length;
  console.log(`${files.length} images, ${zip.length} bytes -> ${join(output,config.package)}\n${warnings} images exceed soft byte budget; inspect report.json before upload.`);
}
main().catch(fail);

```