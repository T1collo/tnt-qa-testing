// Regenerates the PNG fixtures used by manufacturer-destruction.spec.js (MFG-DESTROY-006):
//   proof-small.png  - well under the 512 KB "Proof of destruction" limit
//   proof-large.png  - random noise (incompressible), comfortably over 512 KB
// Run: node tests/portal/fixtures/make-fixtures.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    pixel(raw, row + 1, y, width);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = __dirname;
const small = png(64, 64, (buf, off, y, w) => {
  for (let x = 0; x < w; x++) buf.set([200, 40 + y * 2, 40 + x * 2], off + x * 3);
});
const large = png(600, 600, (buf, off, y, w) => crypto.randomFillSync(buf, off, w * 3)); // ~1 MB
fs.writeFileSync(path.join(dir, 'proof-small.png'), small);
fs.writeFileSync(path.join(dir, 'proof-large.png'), large);
console.log(`proof-small.png ${small.length} bytes, proof-large.png ${large.length} bytes`);
