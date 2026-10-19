// ZIP generation uses only Node built-ins. CRC-32 is the ZIP integrity checksum,
// not encryption. SHA-256 is emitted separately for the published archives.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = ['manifest.json', 'background.js', 'content.js', 'content.css',
  'popup.html', 'popup.js', 'icon.png'];
const SOURCE = [...RUNTIME, 'apps_script.gs', 'README.md', 'SECURITY.md', 'CHANGELOG.md',
  'LICENSE', 'package.json', '.gitignore', '.gitattributes',
  'scripts/check.cjs', 'scripts/build.cjs', 'tests/security.test.cjs', '.github/workflows/ci.yml'];

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files, prefix = '') {
  const localRecords = [], directory = [];
  let offset = 0;
  for (const file of [...files].sort()) {
    const absolute = path.join(ROOT, file);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular source file: ' + file);
    let data = fs.readFileSync(absolute);
    if (!file.endsWith('.png')) data = Buffer.from(data.toString('utf8').replace(/\r\n?/g, '\n'));
    if (data.length > 50 * 1024 * 1024) throw new Error('Unexpectedly large source file: ' + file);
    const name = Buffer.from(prefix + file, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(33, 12); // Fixed DOS date: 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

// Validate before producing any artifact.
require('./check.cjs');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('Invalid extension version');
const output = path.join(ROOT, 'dist');
fs.mkdirSync(output, { recursive: true });
const artifacts = [
  [`chrome-extension-${version}.zip`, zip(RUNTIME)],
  [`github-source-${version}.zip`, zip(SOURCE, 'screenshot-assistant-pro/')]
];
const sums = [];
for (const [name, bytes] of artifacts) {
  fs.writeFileSync(path.join(output, name), bytes);
  sums.push(crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + name);
  console.log(`Built dist/${name} (${bytes.length} bytes)`);
}
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
