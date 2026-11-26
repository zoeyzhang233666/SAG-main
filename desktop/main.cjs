const {app,BrowserWindow,dialog,session,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {createServer}=require('node:net');
const mode=process.argv.find(a=>/^--desktop-smoke=(write|read)$/.test(a))?.split('=')[1];
app.setName('SAG V1');
const dir=mode&&process.env.SAG_V1_SMOKE_DATA?path.resolve(process.env.SAG_V1_SMOKE_DATA):path.join(app.getPath('appData'),'SAG-V1');
fs.mkdirSync(dir,{recursive:true,mode:0o700});app.setPath('userData',dir);
const resources=app.isPackaged?process.resourcesPath:path.join(__dirname,'build','resources');
const backend=path.join(resources,'backend'),pg=path.join(resources,'postgres');
const data=path.join(dir,'postgres-data'),secret=path.join(dir,'postgres-password'),seed=path.join(dir,'seed-complete');
const logs=path.join(dir,'logs');fs.mkdirSync(logs,{recursive:true,mode:0o700});
const pgLog=path.join(logs,'postgres.log'),apiLog=path.join(logs,'backend.log');
const pgExe=n=>path.join(pg,'bin',n+(process.platform==='win32'?'.exe':''));
const base={...process.env};for(const k of Object.keys(base))if(/^(PG[A-Z_]+|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DATABASE_URL|PUBLIC_SHARE_TOKEN|ADMIN_SHARE_TOKEN|SAG_DESKTOP_ACCESS_TOKEN|HTTP_HOST|HTTP_PORT|AUTH_MODE|DEFAULT_TENANT_ID|DOTENV_CONFIG_.*)$/i.test(k))delete base[k];
let win,child,dbStarted=false,closing=false,closed=false,origin,token,startup;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const log=s=>fs.appendFileSync(path.join(logs,'desktop.log'),new Date().toISOString()+' '+s+'\n');
function run(file,args,env=base,logFile=pgLog){
 return new Promise((resolve,reject)=>{
  const fd=fs.openSync(logFile,'a');let c;
  try{c=spawn(file,args,{cwd:backend,env,stdio:['ignore',fd,fd],windowsHide:true});}
  catch(e){reject(e);return;}finally{fs.closeSync(fd);}
  const timer=setTimeout(()=>{c.kill();reject(Error(path.basename(file)+' timed out'));},120000);
  c.once('error',e=>{clearTimeout(timer);reject(e);});
  c.once('exit',(code,signal)=>{clearTimeout(timer);code===0?resolve():reject(Error(path.basename(file)+' exited '+(code??signal)+'; see '+logFile));});
 });
}
function port(){return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function startDatabase(){
 if(fs.existsSync(data)&&!fs.existsSync(secret))throw Error('Existing database password is missing; no data deleted.');
 if(!fs.existsSync(secret))fs.writeFileSync(secret,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
 const password=fs.readFileSync(secret,'utf8').trim();if(!/^[0-9a-f]{64}$/.test(password))throw Error('Invalid database password');
 if(!fs.existsSync(data)){
  const temp=fs.mkdtempSync(path.join(dir,'pg-init-'));
  try{await run(pgExe('initdb'),['-D',temp,'--username=sag_desktop','--pwfile='+secret,'--auth=scram-sha-256','--encoding=UTF8','--no-locale']);fs.renameSync(temp,data);}
  catch(e){fs.rmSync(temp,{recursive:true,force:true});throw e;}
 }
 if(!fs.existsSync(path.join(data,'PG_VERSION'))||fs.readFileSync(path.join(data,'PG_VERSION'),'utf8').trim()!=='16')throw Error('Existing database incompatible or incomplete; no data deleted.');
 const status=()=>spawnSync(pgExe('pg_ctl'),['status','-D',data],{env:base,cwd:backend,windowsHide:true,timeout:10000});
 const s=status();if(s.error)throw s.error;
 if(s.status===0)await run(pgExe('pg_ctl'),['stop','-D',data,'-m','fast','-w','-t','45']);
 else if(s.status!==3)throw Error('Unexpected pg_ctl status '+s.status);
 const p=await port(),opts='-h 127.0.0.1 -p '+p+(process.platform==='win32'?'':' -k ""');
 try{await run(pgExe('pg_ctl'),['start','-D',data,'-l',pgLog,'-o',opts,'-w','-t','45']);dbStarted=true;}
 catch(e){dbStarted=status().status===0;throw e;}
 return 'postgres://sag_desktop:'+password+'@127.0.0.1:'+p+'/postgres';
}
async function startBackend(){
 const url=await startDatabase();token=randomBytes(32).toString('hex');const p=await port();origin='http://127.0.0.1:'+p;
 const env={...base,ELECTRON_RUN_AS_NODE:'1',NODE_ENV:'production',HTTP_HOST:'127.0.0.1',HTTP_PORT:String(p),DATABASE_URL:url,AUTH_MODE:'none',DEFAULT_TENANT_ID:'default',SAG_DESKTOP_ACCESS_TOKEN:token};
 const nodeRun=script=>run(process.execPath,[path.join(backend,script)],env,apiLog);
 await nodeRun('dist/src/db/migrate.js');
 if(!fs.existsSync(seed)){await nodeRun('dist/src/db/seed.js');fs.writeFileSync(seed,'ok\n',{mode:0o600});}
 const fd=fs.openSync(apiLog,'a');
 try{child=spawn(process.execPath,[path.join(backend,'desktop-backend.mjs')],{env,cwd:backend,stdio:['ignore',fd,fd,'ipc'],windowsHide:true});}
 finally{fs.closeSync(fd);}
 child.on('error',e=>log(e.message));
 for(let i=0;i<120;i++){
  if(child.exitCode!==null||child.signalCode!==null)throw Error('Backend exited; see '+apiLog);
  try{const r=await fetch(origin+'/health',{headers:{'x-sag-desktop-token':token},signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).service==='sag')return;}catch{}
  await delay(500);
 }
 throw Error('Backend startup timed out; see '+apiLog);
}
async function stopAll(){
 if(child&&child.exitCode===null&&child.signalCode===null){
  await new Promise(resolve=>{const t=setTimeout(()=>{child.kill();resolve();},10000);child.once('exit',()=>{clearTimeout(t);resolve();});try{if(child.connected)child.send({type:'shutdown'},e=>{if(e)child.kill();});else child.kill();}catch{child.kill();}});
 }
 if(dbStarted){await run(pgExe('pg_ctl'),['stop','-D',data,'-m','fast','-w','-t','45']);dbStarted=false;}
}
function local(url){try{return new URL(url).origin===origin;}catch{return false;}}
async function openWindow(){
 const ses=session.fromPartition('sag-v1');
 ses.webRequest.onBeforeSendHeaders({urls:['<all_urls>']},(d,cb)=>{const h={...d.requestHeaders};if(local(d.url))h['X-SAG-Desktop-Token']=token;cb({requestHeaders:h});});
 ses.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
 win=new BrowserWindow({width:1440,height:900,minWidth:800,minHeight:600,show:!mode,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
 win.webContents.on('will-navigate',(e,url)=>{if(!local(url))e.preventDefault();});
 win.webContents.on('will-frame-navigate',(e,d)=>{if(!local(typeof d==='string'?d:d?.url))e.preventDefault();});
 win.webContents.setWindowOpenHandler(({url})=>{if(local(url))return {action:'deny'};if(/^https?:\/\//i.test(url))void shell.openExternal(url).catch(()=>{});return {action:'deny'};});
 win.on('closed',()=>{win=undefined;});await win.loadURL(origin);
}
async function smoke(){
 if((await fetch(origin+'/api/projects')).status!==401)throw Error('Unauthenticated API access not blocked');
 for(let i=0;i<60;i++){if(await win.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.childElementCount)"))break;if(i===59)throw Error('React frontend did not mount');await delay(500);}
 const ok=await win.webContents.executeJavaScript('(async()=>{const name="SAG V1 desktop smoke";const r=await fetch("/api/projects");if(!r.ok)throw Error("list "+r.status);const list=(await r.json()).projects;if(!Array.isArray(list))throw Error("bad response");if('+JSON.stringify(mode)+'==="read")return list.some(p=>p.name===name);if(list.length!==0)throw Error("database not empty");const c=await fetch("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});if(c.status!==201)throw Error("create "+c.status);return (await (await fetch("/api/projects")).json()).projects.some(p=>p.name===name);})()');
 if(!ok)throw Error('Project smoke failed');
 await stopAll();fs.writeFileSync(path.join(dir,'smoke-'+mode+'.ok'),'ok\n');closed=true;app.exit(0);
}
function fail(e){log(e?.stack||String(e));if(!mode)dialog.showErrorBox('SAG V1 启动失败',String(e?.message||e)+'\n日志：'+logs);closing=true;void stopAll().catch(e=>log(String(e))).finally(()=>{closed=true;app.exit(1);});}
if(!app.requestSingleInstanceLock())app.exit(0);
else{
 app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',e=>{if(closed)return;e.preventDefault();if(closing)return;closing=true;void Promise.resolve(startup).catch(()=>{}).then(stopAll).then(()=>{closed=true;app.exit(0);},e=>{log(String(e));closed=true;app.exit(1);});});
 startup=app.whenReady().then(async()=>{await startBackend();if(closing)return;await openWindow();if(mode)await smoke();});startup.catch(fail);
}
