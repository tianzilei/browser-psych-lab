import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {createServer} from 'node:http';
import {previewTLS} from './preview-tls.mjs';
import { root } from './lib.mjs';

// An isolated TEST_ONLY deployment, separate from the project's .env/data.
const port = Number(process.env.QUESTIONNAIRE_PREVIEW_PORT ?? 3081);
const lan=process.argv.includes('--lan'),tlsPort=Number(process.env.QUESTIONNAIRE_PREVIEW_TLS_PORT??port+1);
if (!Number.isInteger(port) || port < 1024 || port > 65535||!Number.isInteger(tlsPort)||tlsPort<1024||tlsPort>65535||lan&&port===tlsPort) throw new Error('Invalid preview port.');
const addresses=Object.entries(networkInterfaces()).flatMap(([name,entries])=>(entries??[]).filter(e=>e.family==='IPv4'&&!e.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address)).map(e=>({name,ip:e.address}))).sort((a,b)=>Number(b.name==='en0')-Number(a.name==='en0'));
const ip=process.env.QUESTIONNAIRE_PREVIEW_IP??addresses[0]?.ip;
if(lan&&(!ip||isIP(ip)!==4||!addresses.some(a=>a.ip===ip)))throw new Error('No LAN IPv4 address found; set QUESTIONNAIRE_PREVIEW_IP to a local interface address.');
const directory = resolve(root, '.local/questionnaire-preview'), origin = lan?`https://${ip}:${tlsPort}`:`http://127.0.0.1:${port}`;
await mkdir(directory, { recursive: true, mode: 0o700 });
const tls=lan?await previewTLS(directory,ip):null;
const { passwordHash } = await import('../dist/server/auth.js');
const { sampleProtocol } = await import('../dist/shared/protocol.js');
const password = 'TEST_ONLY-local-preview';
Object.assign(process.env, {
  NODE_ENV: 'production', HOST: lan?'0.0.0.0':'127.0.0.1', PORT: String(lan?tlsPort:port), PUBLIC_ORIGIN: lan?'':origin,
  TLS_KEY_PATH:tls?.key??'',TLS_CERT_PATH:tls?.cert??'',
  DATABASE_PATH: resolve(directory, 'database.sqlite'), STORAGE_ROOT: directory,
  ADMIN_PASSWORD_HASH: await passwordHash(password),
  SESSION_CONCURRENCY: '2', PREPARATION_CONCURRENCY: '1', LOG_LEVEL: 'warn',
});
const { app } = await import('../dist/server/main.js');
let redirect;
if(lan){
  const ca=await readFile(tls.download);
  redirect=createServer((request,response)=>{
    if(request.url==='/local-test-ca.cer'){response.writeHead(200,{'Content-Type':'application/x-x509-ca-cert','Content-Disposition':'attachment; filename="local-test-ca.cer"','Cache-Control':'no-store'});response.end(ca);return;}
    if(request.url==='/phone-setup'){
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>手机测试连接</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#e5e5e5;color:#000;font:14px/1.5 system-ui}main{height:100%;padding:3%;display:grid;align-content:center;gap:12px}h1{font-size:22px;margin:0}p{margin:0}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px}a{display:block;padding:12px;border:1px solid currentColor;color:inherit;text-align:center;text-decoration:none;min-height:44px}small{overflow-wrap:anywhere;font-size:10px}@media(max-height:500px),(max-width:360px){html,body{font-size:12px;line-height:1.4}main{padding:2dvh 3vw;gap:6px}h1{font-size:18px}section{gap:6px}a{padding:8px}small{font-size:8px}}</style><main><h1>手机测试连接</h1><p>手机和电脑连接同一 Wi-Fi。首次使用请安装本机测试证书。</p><section><p><b>iPhone / iPad</b><br>下载证书 → 设置 → 通用 → VPN 与设备管理 → 安装描述文件。<br>再到 通用 → 关于本机 → 证书信任设置，开启此测试 CA 的完全信任。</p><p><b>Android</b><br>下载证书 → 系统设置中搜索“安装证书” → 选择 CA 证书。<br>证书名称：Browser Psych Lab TEST_ONLY Local CA。</p></section><section><a href="/local-test-ca.cer">下载本机测试证书</a><a href="${origin}/questionnaire-preview.html">进入模拟问卷</a></section><small>CA SHA-256：${tls.fingerprint}</small></main></html>`);return;
    }
    const target=new URL(request.url??'/',origin);target.protocol='https:';target.hostname=ip;target.port=String(tlsPort);
    response.writeHead(302,{Location:target.href,'Cache-Control':'no-store'});response.end();
  });
  redirect.headersTimeout=10000;redirect.requestTimeout=15000;
  await new Promise((resolve,reject)=>{redirect.once('error',reject);redirect.listen(port,'0.0.0.0',resolve);});
  app.server.once('close',()=>redirect.close());
}

try {
  const headers={origin,host:new URL(origin).host,...(lan?{'x-forwarded-proto':'https'}:{})};
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers,
    payload: { password } });
  if (login.statusCode !== 200) throw new Error(`Preview login failed: ${login.body}`);
  const csrf = login.json().csrf, cookie = String(login.headers['set-cookie']).split(';')[0];
  async function post(url, data) {
    const response = await app.inject({ method: 'POST', url, headers: { ...headers, cookie, 'x-csrf-token': csrf }, payload: data });
    if (response.statusCode >= 400) throw new Error(`Preview setup failed: ${response.body}`);
    return response.json();
  }
  const versions = {};
  for (const [theme, background] of [['gray', '#e5e5e5'], ['dark', '#202020']]) {
    const study = await post('/api/lab/studies', { request_id: randomUUID() });
    const protocol = sampleProtocol();
    protocol.title = theme === 'gray' ? '模拟问卷 · 灰色竖屏' : '模拟问卷 · 深色横屏'; protocol.layout.background = background; protocol.layout.orientation = theme === 'gray' ? 'portrait' : 'landscape';
    protocol.pages = [
      { id: 'basics', title: '基础交互', instruction: '这是本地模拟问卷。请用按钮作答，可返回修改答案。个人信息题只需填写虚构昵称。', questions: [
        { id: 'score', type: 'scale', title: '当前页面操作是否方便？', required: true, min: 1, max: 5, min_label: '非常不方便', max_label: '非常方便', labels: ['非常不方便','不方便','一般','方便','非常方便'] },
        { id: 'feelings', type: 'scales', title: '请从三个方面评价当前体验。', required: true, axes: [
          {id:'ease',title:'操作便利',labels:['很不方便','不方便','一般','方便','很方便']},
          {id:'clarity',title:'内容清晰',labels:['很不清晰','不清晰','一般','清晰','很清晰']},
          {id:'comfort',title:'视觉舒适',labels:['很不舒适','不舒适','一般','舒适','很舒适']},
        ] },
        { id: 'device', type: 'single', title: '你正在使用哪种设备？', required: true, choices: ['手机', '平板', '电脑'] },
        { id: 'uses', type: 'multi', title: '你通常用这台设备做什么？', required: false, choices: ['学习', '工作', '娱乐', '其他'] },
        { id: 'personal', type: 'single', title: '是否体验个人信息输入？', required: true, choices: ['填写模拟昵称', '跳过个人信息'] },
        { id: 'nickname', type: 'text', input_purpose: 'personal', title: '虚构昵称（最多 20 个字符）', required: true, max_length: 20,
          condition: { op: 'eq', question: 'personal', value: '填写模拟昵称' } },
        { id: 'extra', type: 'single', title: '是否继续查看长文本和同屏选项？', required: true, choices: ['继续查看', '直接完成'] },
      ] },
      { id: 'reading', title: '长说明与同屏选项', condition: { op: 'eq', question: 'extra', value: '继续查看' },
        instruction: '以下说明用于检查短屏阅读。\n' + '页面会根据可见空间分段，点击“阅读下一段”继续；文字全部保留。改变设备尺寸不会要求你滚动页面。'.repeat(10),
        questions: [
          { id: 'many', type: 'multi', title: '任选几个编号。全部选项在同一屏显示，此题可留空。', required: false,
            choices: Array.from({ length: 8 }, (_, i) => `选项 ${i + 1}`) },
          { id: 'long', type: 'single', title: '选项文字完整显示，直接点击即可选择。', required: true,
            choices: ['简短选项', '这是一个稍长的选项，用于检查文字完整换行。'] },
        ] },
    ];
    const packed = await readFile(resolve(root, 'examples/stimuli/mobile-stimuli.zip'));
    const uploaded = await app.inject({ method: 'POST', url: `/api/lab/studies/${study.study_id}/package`, headers: { ...headers, cookie, 'x-csrf-token': csrf, 'x-request-id': randomUUID(), 'x-file-name': 'mobile-stimuli.zip', 'content-type': 'application/zip' }, payload: packed });
    if(uploaded.statusCode>=400)throw new Error(`Preview ZIP failed: ${uploaded.body}`);
    const source = { schema: 'questionnaire-v1', title: protocol.title, background, orientation: protocol.layout.orientation, pages: protocol.pages, groups: [{ id: 'shapes', title: '移动图片示例', choices: ['左边','右边'], repeats: 0, trials: [{ root_id: 'card', image: { package: 'mobile-stimuli.zip', path: 'images/mobile-card.png' }, image_ms: 3000, isi_ms: 400, correct: '左边' }] }] };
    source.ending={title:'感谢参与',text:'你的模拟问卷和图片任务已完成，答案已保存。感谢你帮助检查页面，现在可以关闭问卷链接。'};
    source.consent={title:'知情同意书（模拟测试）',text:'这是本机部署的模拟问卷，用于检查手机上的样式、按钮、量表与保存功能。完成后会显示结束语。本次不是正式研究，请只填写虚构的个人信息。\n\n同意后系统会保存模拟答案、操作记录、图片任务响应，以及浏览器、系统、屏幕、语言、时区、网络等浏览器可获取的设备信息和服务器看到的 IP。这些信息用于检查交互与数据记录。\n\n你可以拒绝参加，或在作答过程中关闭页面退出。拒绝时不创建作答会话；已经提交的测试数据会保留在本机测试数据库中，可由管理员下载。\n\n请阅读以上说明。如果愿意继续，请点击“我已阅读并同意”；否则选择“不同意并退出”。'};
    const {frozen:version} = await post(`/api/lab/studies/${study.study_id}/import`, { request_id: randomUUID(), revision: 1, source: JSON.stringify(source, null, 2) });
    await post(`/api/lab/studies/${study.study_id}/admission`, { request_id: randomUUID(), paused: false });
    versions[theme] = { study_id: study.study_id, version_id: version.version_id,
      url: `${origin}/participate.html?version=${version.version_id}` };
  }
  const menu = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>模拟问卷预览</title>
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#e5e5e5;color:#000;font:16px/1.4 system-ui,sans-serif}body{display:grid;place-items:center;padding:4%}main{width:min(100%,420px)}h1{font-size:24px;margin:0 0 12px}p{margin:0 0 20px}nav{display:grid;gap:12px}a{display:grid;place-items:center;min-height:56px;padding:12px;border:1px solid currentColor;color:inherit;text-decoration:none}a:focus-visible{outline:2px solid currentColor;outline-offset:3px}.dark{background:#202020;color:white}</style>
<main><h1>模拟问卷预览</h1><p>灰色要求竖屏，深色要求横屏。请使用模拟信息。</p><nav><a href="/participate.html?version=${versions.gray.version_id}">灰色问卷 · 竖屏</a><a class="dark" href="/participate.html?version=${versions.dark.version_id}">深色问卷 · 横屏</a><a href="/">管理主页</a></nav><p style="font-size:12px;margin-top:12px">本地管理密码：TEST_ONLY-local-preview</p></main></html>`;
  await writeFile(resolve(root, 'dist/web/questionnaire-preview.html'), menu);
  await writeFile(resolve(directory, 'menu.html'), menu);
  const links = { origin, preview: `${origin}/questionnaire-preview.html`,...(lan?{phone_setup:`http://${ip}:${port}/phone-setup`,certificate:`http://${ip}:${port}/local-test-ca.cer`,bind:'0.0.0.0',http_port:port,https_port:tlsPort,ca_fingerprint:tls.fingerprint}:{}),pid: process.pid, ...versions };
  await writeFile(resolve(directory, 'links.json'), JSON.stringify(links, null, 2) + '\n', { mode: 0o600 });
  await writeFile(resolve(directory, 'server.pid'), `${process.pid}\n`, { mode: 0o600 });
  console.log(`Preview ready: ${links.preview}`);
  console.log(`Gray: ${versions.gray.url}\nDark: ${versions.dark.url}`);
  if(lan)console.log(`Phone certificate setup: ${links.phone_setup}`);
} catch (error) { await app.close(); throw error; }
