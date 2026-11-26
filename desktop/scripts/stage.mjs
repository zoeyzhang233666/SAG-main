import fs from 'node:fs';import path from 'node:path';
const root=process.cwd(),dest=path.join(root,'desktop','build','resources');
fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(path.join(dest,'backend'),{recursive:true});
const cp=(a,b)=>fs.cpSync(path.join(root,a),path.join(dest,b),{recursive:true,verbatimSymlinks:true});
cp('dist','backend/dist');cp('migrations','backend/dist/migrations');cp('web/dist','backend/web/dist');cp('package.json','backend/package.json');cp('package-lock.json','backend/package-lock.json');cp('desktop/scripts/backend-entry.mjs','backend/desktop-backend.mjs');cp('postgres-runtime','postgres');cp('LICENSE','SAG-LICENSE.txt');cp('pg-source/COPYRIGHT','PostgreSQL-LICENSE.txt');cp('pgvector-source/LICENSE','pgvector-LICENSE.txt');
fs.rmSync(path.join(dest,'postgres','include'),{recursive:true,force:true});fs.rmSync(path.join(dest,'postgres','lib','pgxs'),{recursive:true,force:true});
for(const n of fs.readdirSync(path.join(dest,'postgres','lib')))if(/\.(a|lib)$/.test(n))fs.rmSync(path.join(dest,'postgres','lib',n),{force:true});
for(const f of ['postgres/bin/postgres'+(process.platform==='win32'?'.exe':''),'backend/dist/src/index.js','backend/web/dist/index.html'])if(!fs.existsSync(path.join(dest,f)))throw Error('Missing runtime file '+f);
