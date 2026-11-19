// No generated frontend is needed: Netlify publishes public/ and bundles functions.
// Fail the build early on syntax errors, broken asset references, or version drift.
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.match(pkg.version,/^\d+\.\d+$/,'Release version must be x.x (example: 2.1), never x.x.x');
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
assert.equal(lock.version,pkg.version,'package-lock version must match package.json');
assert.equal(lock.packages[''].version,pkg.version,'lockfile root version must match');

async function walk(folder){
  const rows=await readdir(join(root,folder),{withFileTypes:true});
  const paths=[];
  for(const row of rows){
    const path=join(folder,row.name);
    if(row.isDirectory())paths.push(...await walk(path));
    else if(row.isFile())paths.push(path);
    else throw Error('Unsupported non-regular project file: '+path);
  }
  return paths;
}

const sources=['server.mjs',...await walk('lib'),...await walk('netlify/functions'),...await walk('public'),...await walk('scripts')];
let checked=0;
for(const file of sources.filter(file=>/\.(?:mjs|js)$/.test(file))){
  const result=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8'});
  if(result.status!==0)throw Error(`Syntax error in ${file}\n${result.stderr||result.error||''}`);
  checked++;
}

const publicRoot=join(root,'public');
const assets=new Set();
for(const file of sources.filter(file=>file.startsWith('public/')&&/\.(?:html|css|js|webmanifest)$/.test(file))){
  const contents=await readFile(join(root,file),'utf8');
  const patterns=[/\b(?:src|href)=["'](\/[^"']+)["']/g,/url\(["']?(\/[^"')]+)["']?\)/g,/"src"\s*:\s*"(\/[^"\s]+)"/g];
  for(const pattern of patterns){
    for(const match of contents.matchAll(pattern)){
      const pathname=match[1].split(/[?#]/)[0];
      if(pathname==='/'||pathname.includes('${'))continue;
      const dest=resolve(publicRoot,'.'+pathname);
      assert.ok(relative(publicRoot,dest)&&!relative(publicRoot,dest).startsWith('..'),'Public reference must stay inside public/');
      await access(dest).catch(()=>{throw Error(`Missing asset ${pathname} referenced in ${file}`);});
      assets.add(pathname);
    }
  }
}
for(const file of await walk('public')){
  assert.ok(!file.split('/').some(p=>p.startsWith('.')),'Hidden files must not be published');
  assert.ok(!/bank\.local|\.env|\.sql$|\.map$/.test(file),'Private data/source maps must not be published');
  assert.ok(['.html','.js','.css','.webmanifest','.svg','.png','.ico'].includes(extname(file)),`Unexpected public file: ${file}`);
}
const html=await readFile(join(publicRoot,'index.html'),'utf8');
assert.ok(html.includes(`?v=${pkg.version}`),'HTML cache version must match release');
const manifest=JSON.parse(await readFile(join(publicRoot,'site.webmanifest'),'utf8'));
assert.ok(manifest.icons.every(icon=>icon.src.endsWith(`?v=${pkg.version}`)),'Manifest icon version must match release');
console.log(`金鹅银行 V${pkg.version}: ${checked} source files and ${assets.size} asset references checked.`);
console.log('Ready: public/ + netlify/functions/ (database and setup token are configured in Netlify).');
