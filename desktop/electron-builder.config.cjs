const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const { productName } = require('./package.json');

// electron-builder's ordinary resource filtering can omit nested node_modules.
// Copy the locked production dependency tree verbatim before signing.
async function afterPack(context){
  const resources=context.electronPlatformName==='darwin'
    ? path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents','Resources')
    : path.join(context.appOutDir,'resources');
  const source=path.join(__dirname,'build','resources','backend','node_modules');
  const backend=path.join(resources,'backend');
  const target=path.join(backend,'node_modules');
  if(!fs.existsSync(path.join(source,'pg','package.json')))throw Error('Staged backend dependencies missing pg');
  if(!fs.existsSync(path.join(backend,'dist','src','db','pool.js')))throw Error('Packaged backend missing pool.js');
  fs.rmSync(target,{recursive:true,force:true});
  fs.cpSync(source,target,{recursive:true,verbatimSymlinks:true});
  const req=createRequire(path.join(backend,'package.json'));
  for(const name of ['pg','fastify','@fastify/static','dotenv','zod','pino','@modelcontextprotocol/sdk/server/index.js']){
    const resolved=req.resolve(name);
    const relative=path.relative(target,resolved);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Packaged dependency resolves outside runtime: '+name);
    console.log('Verified packaged dependency: '+name);
  }
}

module.exports = {
  appId: 'com.chemclaw.sag.v1',
  productName,
  icon: '../web/public/app-icon.png',
  asar: true,
  compression: 'normal',
  npmRebuild: false,
  afterPack,
  directories: { output: 'release' },
  files: ['main.cjs', 'runtime.cjs', 'smoke.cjs', 'package.json'],
  extraResources: [
    { from: 'build/resources/backend', to: 'backend', filter: ['**/*', '!node_modules/**'] },
    { from: 'build/resources/postgres', to: 'postgres' },
    { from: 'build/resources/SAG-LICENSE.txt', to: 'SAG-LICENSE.txt' },
    { from: 'build/resources/PostgreSQL-LICENSE.txt', to: 'PostgreSQL-LICENSE.txt' },
    { from: 'build/resources/pgvector-LICENSE.txt', to: 'pgvector-LICENSE.txt' },
  ],
  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['arm64'] }],
    artifactName: 'SAG-V1-${version}-mac-${arch}.${ext}',
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
  },
  dmg: { sign: false },
  win: {
    executableName: 'SAG V1',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'SAG-V1-Setup-${version}-win-${arch}.${ext}',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: productName,
    deleteAppDataOnUninstall: false,
  },
  publish: null,
};
