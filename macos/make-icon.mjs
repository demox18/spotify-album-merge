import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Icona 1024²: scaffale verde e disco. build-app.sh la riduce con sips e iconutil. */

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
  const shelfTop = [236, 226, 206, 255];
  const shelfFront = [196, 176, 142, 255];
  const shelfEdge = [120, 104, 80, 255];
  const spineGreen = [74, 130, 112, 255];

  const plankTop = Math.round(size * 0.7);
  const plankFront = Math.round(size * 0.735);
  const plankBottom = Math.round(size * 0.8);
  const plankLeft = Math.round(size * 0.14);
  const plankRight = Math.round(size * 0.86);

  const radius = size * 0.2;
  const centerX = size * 0.37;
  const centerY = plankTop - radius * 0.78;

  const spines = [
    { x: 0.58, width: 0.075, height: 0.3, fill: clay, band: paper },
    { x: 0.665, width: 0.075, height: 0.23, fill: paper, band: spineGreen },
    { x: 0.75, width: 0.075, height: 0.27, fill: spineGreen, band: clay },
  ].map((spine) => ({
    left: Math.round(size * spine.x),
    right: Math.round(size * (spine.x + spine.width)),
    top: Math.round(plankTop - size * spine.height),
    fill: spine.fill,
    band: spine.band,
  }));

  function paint(x, y, pixel) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    raw[offset] = pixel[0];
    raw[offset + 1] = pixel[1];
    raw[offset + 2] = pixel[2];
    raw[offset + 3] = pixel[3];
  }

  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) paint(x, y, background);
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > radius) continue;
      let pixel = paper;
      for (const ring of [0.8, 0.64, 0.48]) {
        if (Math.abs(distance - radius * ring) < size * 0.008) pixel = groove;
      }
      if (distance <= radius * 0.28) pixel = clay;
      if (distance <= radius * 0.07) pixel = background;
      paint(x, y, pixel);
    }
  }

  for (const spine of spines) {
    const bandTop = spine.top + Math.round((plankTop - spine.top) * 0.18);
    const bandBottom = bandTop + Math.max(2, Math.round(size * 0.028));
    for (let y = spine.top; y < plankTop; y += 1) {
      for (let x = spine.left; x < spine.right; x += 1) {
        const pixel = y >= bandTop && y < bandBottom ? spine.band : spine.fill;
        paint(x, y, pixel);
      }
    }
  }

  for (let y = plankTop; y < plankBottom; y += 1) {
    let pixel = shelfFront;
    if (y < plankFront) pixel = shelfTop;
    else if (y >= plankBottom - Math.max(2, Math.round(size * 0.012))) pixel = shelfEdge;
    for (let x = plankLeft; x < plankRight; x += 1) paint(x, y, pixel);
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

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, '.build');
mkdirSync(directory, { recursive: true });
const output = join(directory, 'icon-1024.png');
writeFileSync(output, png(1024));
console.log(output);
