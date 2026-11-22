const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = __dirname;
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.manifest_version, 3, 'Expected a Manifest V3 extension');

for (const name of ['background.js', 'content.js', 'popup.js', 'apps_script.gs',
  'check.cjs', 'build.cjs', 'release.test.cjs']) {
  new vm.Script(read(name), { filename: name });
}

const assets = [manifest.background.service_worker, manifest.action.default_popup,
  manifest.action.default_icon, ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap(script => [...(script.js || []), ...(script.css || [])])];
for (const name of assets) {
  assert.equal(typeof name, 'string');
  assert.ok(/^[a-zA-Z0-9_.-]+$/.test(name), 'Assets must be local root files: ' + name);
  assert.ok(fs.lstatSync(path.join(root, name)).isFile(), 'Missing asset: ' + name);
}

assert.equal(manifest.version, '2.2', 'Expected original v2.2 runtime');
assert.equal(JSON.parse(read('package.json')).version, '2.2.0', 'Tooling version must match v2.2');
assert.equal(Object.keys(JSON.parse(read('package.json')).dependencies || {}).length, 0);
console.log('Syntax, Manifest V3 and local asset checks passed.');
