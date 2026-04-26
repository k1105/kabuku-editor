/**
 * Big-endian binary writer for OpenType / TrueType tables.
 *
 * The OpenType spec uses big-endian throughout. Each table is built into a
 * Uint8Array; an sfnt wrapper stitches them together with a table directory
 * and a head-table checksum adjustment.
 */

export class BinaryWriter {
  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.length = 0;
  }

  _ensure(extra) {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
  }

  u8(v) { this._ensure(1); this.buf[this.length++] = v & 0xff; }
  u16(v) {
    this._ensure(2);
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
  }
  i16(v) { this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) {
    this._ensure(4);
    this.buf[this.length++] = (v >>> 24) & 0xff;
    this.buf[this.length++] = (v >>> 16) & 0xff;
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
  }
  i32(v) { this.u32(v < 0 ? v + 0x100000000 : v); }

  /** Fixed 16.16 (signed 32-bit, fractional part * 65536). */
  fixed(v) { this.i32(Math.round(v * 65536)); }
  /** F2DOT14: signed 16-bit, fractional bits = 14 (range -2..2). */
  f2dot14(v) { this.i16(Math.round(v * 16384)); }
  /** FWord = signed 16-bit in font units. */
  fword(v) { this.i16(v); }
  /** UFWord = unsigned 16-bit in font units. */
  ufword(v) { this.u16(v); }

  /** LONGDATETIME: signed 64-bit seconds since 1904-01-01 UTC. */
  longDateTime(secondsSince1904) {
    // JS bitwise ops are 32-bit. Split high/low.
    const hi = Math.floor(secondsSince1904 / 0x100000000);
    const lo = secondsSince1904 >>> 0;
    this.u32(hi);
    this.u32(lo);
  }

  /** Append a 4-byte ASCII tag. */
  tag(s) {
    if (s.length !== 4) throw new Error(`tag must be 4 chars: ${s}`);
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i));
  }

  /** Append raw bytes. */
  bytes(arr) {
    if (!(arr instanceof Uint8Array)) arr = new Uint8Array(arr);
    this._ensure(arr.length);
    this.buf.set(arr, this.length);
    this.length += arr.length;
  }

  /** Pad with zeros until length is a multiple of `align`. */
  pad(align = 4) {
    while (this.length % align !== 0) this.u8(0);
  }

  /** Snapshot the current contents. */
  toUint8Array() {
    return this.buf.subarray(0, this.length);
  }
}

/** Calculate the 32-bit checksum over a table buffer (zero-padded to 4 bytes). */
export function tableChecksum(bytes) {
  let sum = 0;
  const len = bytes.length;
  // Process 4 bytes at a time, treating remainder as zero-padded.
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    const v = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    sum = (sum + (v >>> 0)) >>> 0;
  }
  if (i < len) {
    let tail = 0;
    for (let j = 0; j < 4; j++) {
      tail = (tail << 8) | (i + j < len ? bytes[i + j] : 0);
    }
    sum = (sum + (tail >>> 0)) >>> 0;
  }
  return sum;
}

/**
 * Pack a list of named tables (each Uint8Array) into a complete sfnt binary
 * with a table directory. `tables` = [{ tag: 'head', bytes: Uint8Array }, ...]
 *
 * The `head` table's checkSumAdjustment field at offset 8 must be zero when
 * computing checksums. We patch it after all checksums are computed.
 *
 * @param {Array<{tag: string, bytes: Uint8Array}>} tables
 * @param {string} [sfntVersion] - '\x00\x01\x00\x00' for TTF, 'OTTO' for CFF/OTF
 * @returns {Uint8Array}
 */
export function buildSfnt(tables, sfntVersion = '\x00\x01\x00\x00') {
  // Sort tables by tag name (ascending) — required by spec.
  tables = tables.slice().sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const numTables = tables.length;
  const log2N = Math.floor(Math.log2(numTables));
  const searchRange = (1 << log2N) * 16;
  const entrySelector = log2N;
  const rangeShift = numTables * 16 - searchRange;

  const headerSize = 12 + 16 * numTables;

  // Compute final offsets (each table 4-byte aligned)
  let offset = headerSize;
  const records = tables.map(t => {
    const padded = t.bytes.length + ((4 - (t.bytes.length % 4)) % 4);
    const rec = {
      tag: t.tag,
      checkSum: tableChecksum(t.bytes),
      offset,
      length: t.bytes.length,
      padded,
      bytes: t.bytes,
    };
    offset += padded;
    return rec;
  });

  // Build header + directory + bodies
  const totalSize = offset;
  const out = new BinaryWriter(totalSize);

  // sfnt header
  for (let i = 0; i < 4; i++) out.u8(sfntVersion.charCodeAt(i));
  out.u16(numTables);
  out.u16(searchRange);
  out.u16(entrySelector);
  out.u16(rangeShift);

  // Table records
  for (const r of records) {
    out.tag(r.tag);
    out.u32(r.checkSum);
    out.u32(r.offset);
    out.u32(r.length);
  }

  // Table bodies (with 4-byte padding)
  for (const r of records) {
    out.bytes(r.bytes);
    const pad = r.padded - r.length;
    for (let i = 0; i < pad; i++) out.u8(0);
  }

  const bin = out.toUint8Array();

  // Patch head.checkSumAdjustment = 0xB1B0AFBA - sum(entire font)
  const headRec = records.find(r => r.tag === 'head');
  if (!headRec) throw new Error('head table missing');
  // Make sure head.checkSumAdjustment was zero when its checksum was computed.
  // (Caller must produce head bytes with that field zeroed.)
  const fontCheckSum = tableChecksum(bin);
  const adjustment = (0xB1B0AFBA - fontCheckSum) >>> 0;
  // checkSumAdjustment is at offset 8 within the head table.
  const headOffset = headRec.offset;
  const adjustOffset = headOffset + 8;
  bin[adjustOffset] = (adjustment >>> 24) & 0xff;
  bin[adjustOffset + 1] = (adjustment >>> 16) & 0xff;
  bin[adjustOffset + 2] = (adjustment >>> 8) & 0xff;
  bin[adjustOffset + 3] = adjustment & 0xff;

  return bin;
}
