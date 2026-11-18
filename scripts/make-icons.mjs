import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function crc32(buffer) {
  let crc = ~0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const background = [29, 60, 52, 255];
  const paper = [244, 239, 228, 255];
  const groove = [36, 88, 76, 255];
  const clay = [196, 81, 44, 255];
  const centerX = (size - 1) / 2;
  const radius = size * 0.34;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerX);
      let pixel = background;
      if (distance <= radius) {
        pixel = paper;
        for (const ring of [0.78, 0.62, 0.46]) {
          if (Math.abs(distance - radius * ring) < size * 0.012) pixel = groove;
        }
        if (distance <= radius * 0.2) pixel = clay;
        if (distance <= radius * 0.07) pixel = background;
      }
      const offset = row + 1 + x * 4;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192));
writeFileSync('public/icons/icon-512.png', png(512));
writeFileSync('public/icons/apple-touch-icon.png', png(180));
