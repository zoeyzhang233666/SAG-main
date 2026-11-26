import {spawnSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const exe=process.argv[2];if(!exe||!fs.existsSync(exe))throw Error('Missing executable '+exe);
const data=fs.mkdtempSync(path.join(os.tmpdir(),'sag-v1-desktop-test-'));
try{for(const mode of ['write','read']){const r=spawnSync(exe,['--desktop-smoke='+mode],{env:{...process.env,SAG_V1_SMOKE_DATA:data},stdio:'inherit',timeout:300000,windowsHide:true});if(r.error||r.status!==0||!fs.existsSync(path.join(data,'smoke-'+mode+'.ok'))){for(const n of ['desktop.log','backend.log','postgres-control.log','postgres.log']){const f=path.join(data,'logs',n);if(fs.existsSync(f))console.error(n+'\n'+fs.readFileSync(f,'utf8').slice(-18000));}throw Error('Packaged smoke '+mode+' failed: '+(r.error?.message||r.status));}}console.log('Packaged UI, authenticated API, project write and restart passed.');}
finally{fs.rmSync(data,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
