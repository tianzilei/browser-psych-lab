import {mkdir,access,writeFile,chmod,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
const execute=promisify(execFile);

// A private, preview-only CA. Its public certificate can be installed on a test
// phone; this helper never modifies the computer's or phone's trust store.
export async function previewTLS(directory,ip){
  const tls=resolve(directory,'tls');await mkdir(tls,{recursive:true,mode:0o700});
  const ca=resolve(tls,'ca.pem'),caKey=resolve(tls,'ca-key.pem'),key=resolve(tls,'server-key.pem'),cert=resolve(tls,'server.pem');
  const run=args=>execute('openssl',args);
  try{await access(ca);await access(caKey);}catch{
    await run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365','-keyout',caKey,'-out',ca,'-subj','/CN=Browser Psych Lab TEST_ONLY Local CA',
      '-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  }
  const csr=resolve(tls,'server.csr'),extensions=resolve(tls,'server.ext');
  await writeFile(extensions,`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:${ip}\n`,{mode:0o600});
  await run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-keyout',key,'-out',csr,'-subj','/CN=Browser Psych Lab local preview']);
  await run(['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','30','-sha256','-extfile',extensions]);
  await Promise.all([chmod(caKey,0o600),chmod(key,0o600)]);
  await run(['verify','-CAfile',ca,cert]);
  const download=resolve(tls,'local-test-ca.cer');await run(['x509','-in',ca,'-outform','DER','-out',download]);
  return {key,cert,download,fingerprint:new X509Certificate(await readFile(ca)).fingerprint256};
}
