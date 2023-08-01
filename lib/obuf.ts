// Original repo: https://github.com/indutny/offset-buffer
// Ported to Typescript for /x/spdy_transport

export class OffsetBuffer {
  offset: number;
  size: number;
  buffers: Uint8Array[];

  constructor() {
    this.offset = 0;
    this.size = 0;
    this.buffers = [];
  }

  isEmpty() {
    return this.size === 0;
  }

  clone(size: number) {
    const r = new OffsetBuffer();
    r.offset = this.offset;
    r.size = size;
    r.buffers = this.buffers.slice();
    return r;
  }

  toChunks() {
    if (this.size === 0)
      return [];

    // We are going to slice it anyway
    if (this.offset !== 0) {
      this.buffers[0] = this.buffers[0].slice(this.offset);
      this.offset = 0;
    }

    const chunks = [ ];
    let off = 0;
    let i: number;
    for (i = 0; off <= this.size && i < this.buffers.length; i++) {
      let buf = this.buffers[i];
      off += buf.length;

      // Slice off last buffer
      if (off > this.size) {
        buf = buf.slice(0, buf.length - (off - this.size));
        this.buffers[i] = buf;
      }

      chunks.push(buf);
    }

    // If some buffers were skipped - trim length
    if (i < this.buffers.length)
      this.buffers.length = i;

    return chunks;
  }

  // toString(enc) {
  //   return this.toChunks().map(function(c) {
  //     return c.toString(enc);
  //   }).join('');
  // };

  use(buf: Uint8Array, off: number, n: number) {
    this.buffers = [ buf ];
    this.offset = off;
    this.size = n;
  }

  push(data: Uint8Array) {
    // Ignore empty writes
    if (data.length === 0)
      return;

    this.size += data.length;
    this.buffers.push(data);
  }

  has(n: number) {
    return this.size >= n;
  }

  skip(n: number) {
    if (this.size === 0)
      return;

    this.size -= n;

    // Fast case, skip bytes in a first buffer
    if (this.offset + n < this.buffers[0].length) {
      this.offset += n;
      return;
    }

    let left = n - (this.buffers[0].length - this.offset);
    this.offset = 0;

    let shift: number;
    for (shift = 1; left > 0 && shift < this.buffers.length; shift++) {
      const buf = this.buffers[shift];
      if (buf.length > left) {
        this.offset = left;
        break;
      }
      left -= buf.length;
    }
    this.buffers = this.buffers.slice(shift);
  }

  copy(target: Uint8Array, targetOff: number, off: number, n: number) {
    if (this.size === 0)
      return;
    if (off !== 0)
      throw new Error('Unsupported offset in .copy()');

    let toff = targetOff;
    const first = this.buffers[0];
    const toCopy = Math.min(n, first.length - this.offset);
    target.set(first.slice(this.offset, this.offset+toCopy), toff);
    // first.copy(target, toff, this.offset, this.offset + toCopy);

    toff += toCopy;
    let left = n - toCopy;
    for (let i = 1; left > 0 && i < this.buffers.length; i++) {
      const buf = this.buffers[i];
      const toCopy = Math.min(left, buf.length);

      target.set(buf.slice(0, toCopy), toff);
      // buf.copy(target, toff, 0, toCopy);

      toff += toCopy;
      left -= toCopy;
    }
  }

  take(n: number) {
    if (n === 0)
      return new Uint8Array(0);

    this.size -= n;

    // Fast cases
    const first = this.buffers[0].length - this.offset;
    if (first === n) {
      let r = this.buffers.shift()!;
      if (this.offset !== 0) {
        r = r.slice(this.offset);
        this.offset = 0;
      }
      return r;
    } else if (first > n) {
      const r = this.buffers[0].slice(this.offset, this.offset + n);
      this.offset += n;
      return r;
    }

    // Allocate and fill buffer
    const out = new Uint8Array(n);
    let toOff = 0;
    let startOff = this.offset;
    let i: number;
    for (i = 0; toOff !== n && i < this.buffers.length; i++) {
      const buf = this.buffers[i];
      const toCopy = Math.min(buf.length - startOff, n - toOff);

      out.set(buf.slice(startOff, startOff+toCopy), toOff);
      // buf.copy(out, toOff, startOff, startOff + toCopy);
      if (startOff + toCopy < buf.length) {
        this.offset = startOff + toCopy;
        break;
      } else {
        toOff += toCopy;
        startOff = 0;
      }
    }

    this.buffers = this.buffers.slice(i);
    if (this.buffers.length === 0)
      this.offset = 0;

    return out;
  }

  peekUInt8() {
    return this.buffers[0][this.offset];
  }

  readUInt8() {
    this.size -= 1;
    const first = this.buffers[0];
    const r = first[this.offset];
    if (++this.offset === first.length) {
      this.offset = 0;
      this.buffers.shift();
    }

    return r;
  }

  readUInt16LE() {
    const first = this.buffers[0];
    this.size -= 2;

    let r: number;
    let shift: number;

    // Fast case - first buffer has all bytes
    if (first.length - this.offset >= 2) {
      r = new DataView(first.buffer).getUint16(this.offset, true);
      shift = 0;
      this.offset += 2;

    // One byte here - one byte there
    } else {
      r = first[this.offset] | (this.buffers[1][0] << 8);
      shift = 1;
      this.offset = 1;
    }

    if (this.offset === this.buffers[shift].length) {
      this.offset = 0;
      shift++;
    }
    if (shift !== 0)
      this.buffers = this.buffers.slice(shift);

    return r;
  }

  readUInt24LE() {
    const first = this.buffers[0];

    let r: number;
    let shift: number;
    const firstHas = first.length - this.offset;

    // Fast case - first buffer has all bytes
    if (firstHas >= 3) {
      r = new DataView(first.buffer).getUint16(this.offset, true) | (first[this.offset + 2] << 16);
      shift = 0;
      this.offset += 3;

    // First buffer has 2 of 3 bytes
    } else if (firstHas >= 2) {
      r = new DataView(first.buffer).getUint16(this.offset, true) | (this.buffers[1][0] << 16);
      shift = 1;
      this.offset = 1;

    // Slow case: First buffer has 1 of 3 bytes
    } else {
      r = first[this.offset];
      this.offset = 0;
      this.buffers.shift();
      this.size -= 1;

      r |= this.readUInt16LE() << 8;
      return r;
    }

    this.size -= 3;
    if (this.offset === this.buffers[shift].length) {
      this.offset = 0;
      shift++;
    }
    if (shift !== 0)
      this.buffers = this.buffers.slice(shift);

    return r;
  }

  readUInt32LE() {
    const first = this.buffers[0];

    let r: number;
    let shift: number;
    const firstHas = first.length - this.offset;

    // Fast case - first buffer has all bytes
    if (firstHas >= 4) {
      r = new DataView(first.buffer).getUint32(this.offset, true);
      shift = 0;
      this.offset += 4;

    // First buffer has 3 of 4 bytes
    } else if (firstHas >= 3) {
      r = (new DataView(first.buffer).getUint16(this.offset, true) |
          (first[this.offset + 2] << 16)) +
          (this.buffers[1][0] * 0x1000000);
      shift = 1;
      this.offset = 1;

    // Slow case: First buffer has 2 of 4 bytes
    } else if (firstHas >= 2) {
      r = new DataView(first.buffer).getUint16(this.offset, true);
      this.offset = 0;
      this.buffers.shift();
      this.size -= 2;

      r += this.readUInt16LE() * 0x10000;
      return r;

    // Slow case: First buffer has 1 of 4 bytes
    } else {
      r = first[this.offset];
      this.offset = 0;
      this.buffers.shift();
      this.size -= 1;

      r += this.readUInt24LE() * 0x100;
      return r;
    }

    this.size -= 4;
    if (this.offset === this.buffers[shift].length) {
      this.offset = 0;
      shift++;
    }
    if (shift !== 0)
      this.buffers = this.buffers.slice(shift);

    return r;
  }

  readUInt16BE() {
    const r = this.readUInt16LE();

    return ((r & 0xff) << 8) | (r >> 8);
  }

  readUInt24BE() {
    const r = this.readUInt24LE();

    return ((r & 0xff) << 16) | (((r >> 8) & 0xff) << 8) | (r >> 16);
  }

  readUInt32BE() {
    const r = this.readUInt32LE();

    return (((r & 0xff) << 24) |
            (((r >>> 8) & 0xff) << 16) |
            (((r >>> 16) & 0xff) << 8) |
            (r >>> 24)) >>> 0;
  }

  // Signed number APIs

  peekInt8() {
    return signedInt8(this.peekUInt8());
  }

  readInt8() {
    return signedInt8(this.readUInt8());
  }

  readInt16BE() {
    return signedInt16(this.readUInt16BE());
  }

  readInt16LE() {
    return signedInt16(this.readUInt16LE());
  }

  readInt24BE() {
    return signedInt24(this.readUInt24BE());
  }

  readInt24LE() {
    return signedInt24(this.readUInt24LE());
  }

  readInt32BE() {
    return signedInt32(this.readUInt32BE());
  }

  readInt32LE() {
    return signedInt32(this.readUInt32LE());
  }
}

function signedInt8(num: number) {
  if (num >= 0x80)
    return -(0xff ^ num) - 1;
  else
    return num;
}

function signedInt16(num: number) {
  if (num >= 0x8000)
    return -(0xffff ^ num) - 1;
  else
    return num;
}

function signedInt24(num: number) {
  if (num >= 0x800000)
    return -(0xffffff ^ num) - 1;
  else
    return num;
}

function signedInt32(num: number) {
  if (num >= 0x80000000)
    return -(0xffffffff ^ num) - 1;
  else
    return num;
}
