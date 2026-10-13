// Generates build/icon.png (512×512), the app icon used by the installer and window.
// Drawn pixel by pixel (no image libraries): a dark rounded square with a jog-wheel ring,
// half in deck 1's colour and half in deck 2's, and an accent dot in the middle.
// Run: node scripts/make-icon.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const N = 512
const px = new Uint8Array(N * N * 4)

const BG = [13, 15, 19]
const DECK1 = [47, 214, 181]
const DECK2 = [255, 122, 89]
const ACCENT = [143, 123, 255]
const RING = [35, 40, 51]

function blend(i, rgb, a) {
  for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * (1 - a) + rgb[c] * a)
  px[i + 3] = Math.max(px[i + 3], Math.round(a * 255))
}

// Coverage of a shape at a pixel, from a signed distance (negative = inside): 1-px soft edge.
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d))

const c = N / 2
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4
    const fx = x + 0.5
    const fy = y + 0.5
    // rounded square background
    const r = 104
    const qx = Math.max(Math.abs(fx - c) - (c - 16 - r), 0)
    const qy = Math.max(Math.abs(fy - c) - (c - 16 - r), 0)
    const dBox = Math.hypot(qx, qy) - r
    blend(i, BG, cover(dBox))
    if (dBox > 0) continue
    const dist = Math.hypot(fx - c, fy - c)
    // outer platter
    blend(i, RING, cover(dist - 190))
    // coloured progress ring: left half deck 1, right half deck 2, small gaps top/bottom
    const ringD = Math.abs(dist - 165) - 22
    const ang = Math.atan2(fx - c, -(fy - c)) // 0 at top, clockwise
    const gap = 0.16
    const onRing = Math.abs(ang) > gap && Math.PI - Math.abs(ang) > gap
    if (onRing) blend(i, ang > 0 ? DECK2 : DECK1, cover(ringD))
    // inner disc + rotating marker
    blend(i, [20, 23, 29], cover(dist - 118))
    const mx = fx - c
    const my = fy - c
    // marker line from the centre towards ~1 o'clock
    const a = -Math.PI / 3
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    const t = Math.max(30, Math.min(105, mx * ux + my * uy))
    const dLine = Math.hypot(mx - ux * t, my - uy * t) - 9
    blend(i, [232, 235, 241], cover(dLine))
    // centre dot
    blend(i, ACCENT, cover(dist - 30))
  }
}

// ---- minimal PNG encoder ----
const crcTable = new Uint32Array(256).map((_, n) => {
  let k = n
  for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1
  return k >>> 0
})
function crc32(buf) {
  let crc = 0xffffffff
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0 // filter: none
  Buffer.from(px.buffer, y * N * 4, N * 4).copy(raw, y * (N * 4 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('wrote build/icon.png')
