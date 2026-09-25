// A tiny, dependency-free PNG encoder, used only to generate simple placeholder card artwork (a flat
// navy rectangle with a gold border) so the system works out of the box. Replace the files in
// own-wallet/assets/ with the club's real icon and logo — see own-wallet/README.md.
'use strict';

const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// bg/border are [r,g,b]. Draws a flat rectangle of bg with a 2px border of `border`.
function solidPng(width, height, bg, border) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const onEdge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      const c = (border && onEdge) ? border : bg;
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB, no interlace
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const NAVY = [0x13, 0x29, 0x4B];
const GOLD = [0xD7, 0xB4, 0x6A];

// Apple's recommended sizes for a generic/storeCard pass icon and logo.
function defaultAppleImages() {
  return {
    iconPng: solidPng(29, 29, NAVY, GOLD),
    icon2xPng: solidPng(58, 58, NAVY, GOLD),
    logoPng: solidPng(160, 50, NAVY, GOLD),
    logo2xPng: solidPng(320, 100, NAVY, GOLD),
  };
}

module.exports = { solidPng, defaultAppleImages, NAVY, GOLD };
