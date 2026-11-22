// Release integrity checks, not security regression tests for the legacy runtime.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = __dirname;
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const runtime = ['manifest.json','background.js','content.js','content.css','popup.html','popup.js','icon.png'];

test('v2.2 manifest and tooling versions agree; backend and JS parse',()=>{
  assert.equal(JSON.parse(read('manifest.json')).version,'2.2');
  assert.equal(JSON.parse(read('package.json')).version,'2.2.0');
  for(const file of ['background.js','content.js','popup.js','apps_script.gs']) new vm.Script(read(file),{filename:file});
});

test('every asset Chrome loads is included in the installation runtime',()=>{
  const m=JSON.parse(read('manifest.json'));
  const assets=[m.background.service_worker,m.action.default_popup,m.action.default_icon,...Object.values(m.icons),
    ...m.content_scripts.flatMap(s=>[...(s.js||[]),...(s.css||[])])];
  for(const match of read('popup.html').matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) assets.push(match[1]);
  for(const asset of assets){assert(runtime.includes(asset),'Missing from install package: '+asset);assert(fs.statSync(path.join(root,asset)).isFile());}
});

test('all literal popup element IDs resolve in v2.2 HTML',()=>{
  const ids=[...read('popup.html').matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
  for(const match of read('popup.js').matchAll(/getElementById\("([^"]+)"\)/g)) assert(ids.includes(match[1]),'Missing UI element '+match[1]);
});

test('npm entry points resolve to current root files, not old directories',()=>{
  const scripts=JSON.parse(read('package.json')).scripts;
  assert.equal(scripts.check,'node check.cjs');assert.equal(scripts.test,'node --test release.test.cjs');assert.equal(scripts.build,'node build.cjs');
  for(const f of ['check.cjs','release.test.cjs','build.cjs']) assert(fs.statSync(path.join(root,f)).isFile());
});

test('historical files are not active root tests or workflow configuration',()=>{
  for(const f of ['security.test.cjs','ci.yml','download','download (1)']) {
    assert(!fs.existsSync(path.join(root,f)));
    assert(fs.statSync(path.join(root,'archive','v2.1',f)).isFile());
  }
});
