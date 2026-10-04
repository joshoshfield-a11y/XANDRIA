/**
 * Minimal ZIP writer — zero dependencies, pure Node (node:zlib for deflate).
 * Produces standard ZIP archives (deflated entries) readable by unzip/7-Zip/
 * Windows Explorer/macOS Archive Utility and accepted by itch.io.
 */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Uint8Array;
  crc: number;
  compressed: Uint8Array;
  offset: number;
}

function dosTime(): number {
  const d = new Date();
  return (
    ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0
  );
}
function dosDate(): number {
  const d = new Date();
  return (
    (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) >>> 0
  );
}

export class ZipBuilder {
  private entries: Entry[] = [];

  add(name: string, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.entries.push({
      name,
      data: bytes,
      crc: crc32(bytes),
      compressed: deflateRawSync(bytes, { level: 9 }),
      offset: 0,
    });
  }

  build(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const enc = new TextEncoder();
    const push = (b: Uint8Array) => chunks.push(b);

    let offset = 0;
    const central: Uint8Array[] = [];
    for (const e of this.entries) {
      e.offset = offset;
      const nameBytes = enc.encode(e.name);
      // Local file header
      const lh = new Uint8Array(30);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); // signature
      dv.setUint16(4, 20, true); // version needed
      dv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      dv.setUint16(8, 8, true); // deflate
      dv.setUint16(10, dosTime(), true);
      dv.setUint16(12, dosDate(), true);
      dv.setUint32(14, e.crc, true);
      dv.setUint32(18, e.compressed.length, true);
      dv.setUint32(22, e.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true); // extra len
      push(lh);
      push(nameBytes);
      push(e.compressed);
      offset += 30 + nameBytes.length + e.compressed.length;

      // Central directory entry
      const ch = new Uint8Array(46);
      const cd = new DataView(ch.buffer);
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); // version made by
      cd.setUint16(6, 20, true); // version needed
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 8, true);
      cd.setUint16(12, dosTime(), true);
      cd.setUint16(14, dosDate(), true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.compressed.length, true);
      cd.setUint32(24, e.data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      for (const o of [30, 32, 34, 36, 38, 40]) cd.setUint16(o, 0, true);
      cd.setUint32(42, e.offset, true);
      central.push(ch, nameBytes);
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) {
      push(c);
      centralSize += c.length;
    }
    offset += centralSize;

    // End of central directory
    const end = new Uint8Array(22);
    const ed = new DataView(end.buffer);
    ed.setUint32(0, 0x06054b50, true);
    ed.setUint16(8, this.entries.length, true);
    ed.setUint16(10, this.entries.length, true);
    ed.setUint32(12, centralSize, true);
    ed.setUint32(16, centralStart, true);
    push(end);

    const total = offset + 22;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}
