import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// A small ZIP with stored entries needs no platform-specific zip binary or new dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from('binance-browser/' + name),
      checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
const root = new URL('../', import.meta.url);
const names = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'README.md',
];
const entries = await Promise.all(
  names.map(async (name) => [name, await readFile(new URL('extensions/binance-browser/' + name, root))]),
);
entries.push(['INTEGRATION.md', await readFile(new URL('docs/binance-chat-integration.md', root))]);
entries.push(['LICENSE', await readFile(new URL('LICENSE', root))]);
const manifest = JSON.parse(entries[0][1].toString()),
  version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid extension version');
const archive = zip(entries),
  filename = `qianyu-superbot-binance-bridge-v${version}.zip`;
for (const path of ['.local/releases/', 'dist/admin/downloads/']) {
  const destination = new URL(path, root);
  await mkdir(destination, { recursive: true });
  await writeFile(new URL(filename, destination), archive);
  await writeFile(
    new URL(filename + '.sha256', destination),
    createHash('sha256').update(archive).digest('hex') + '  ' + filename + '\n',
  );
  if (path.startsWith('dist/')) await writeFile(new URL('binance-bridge-latest.zip', destination), archive);
}
console.log(
  `Packaged Binance extension v${version}: ${archive.length} bytes; explicit file allowlist, no pairing data.`,
);
