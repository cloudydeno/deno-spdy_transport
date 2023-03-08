// Original repo: https://github.com/indutny/wbuf
// Ported to Typescript for /x/spdy_transport

import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";

export class WriteBuffer {
  buffers: Uint8Array[];
  toReserve: number;
  size: number;
  maxSize: number;
  avail: number;
  last: null | Uint8Array;
  offset: number;
  sliceQueue: null | Uint8Array[];
  forceReserve: boolean;
  reserveRate: number;

  constructor() {
    this.buffers = [];
    this.toReserve = 0;
    this.size = 0;
    this.maxSize = 0;
    this.avail = 0;

    this.last = null;
    this.offset = 0;

    // Used in slicing
    this.sliceQueue = null;

    this.forceReserve = false;

    // Mostly a constant
    this.reserveRate = 64;
  }

  reserve(n: number) {
    this.toReserve += n;

    // Force reservation of extra bytes
    if (this.forceReserve)
      this.toReserve = Math.max(this.toReserve, this.reserveRate);
  };

  _ensure(n: number) {
    if (this.avail >= n)
      return;

    if (this.toReserve === 0)
      this.toReserve = this.reserveRate;

    this.toReserve = Math.max(n - this.avail, this.toReserve);

    if (this.avail === 0)
      this._next();
  };

  _next() {
    var buf: Uint8Array;
    if (this.sliceQueue === null) {
      // Most common case
      buf = new Uint8Array(this.toReserve);
    } else {
      // Only for `.slice()` results
      buf = this.sliceQueue.shift()!;
      if (this.sliceQueue.length === 0)
        this.sliceQueue = null;
    }

    this.toReserve = 0;

    this.buffers.push(buf);
    this.avail = buf.length;
    this.offset = 0;
    this.last = buf;
  };

  _rangeCheck() {
    if (this.maxSize !== 0 && this.size > this.maxSize)
      throw new RangeError('WBuf overflow');
  };

  _move(n: number) {
    this.size += n;
    if (this.avail === 0)
      this.last = null;

    this._rangeCheck();
  };

  slice(start: number, end: number) {
    assert(0 <= start && start <= this.size);
    assert(0 <= end && end <= this.size);

    if (this.last === null)
      this._next();

    var res = new WriteBuffer();

    // Only last chunk is requested
    if (start >= this.size - this.offset) {
      assert(this.last);
      res.buffers.push(this.last);
      res.last = this.last;
      res.offset = start - this.size + this.offset;
      res.maxSize = end - start;
      res.avail = res.maxSize;

      return res;
    }

    var startIndex = -1;
    var startOffset = 0;
    var endIndex = -1;

    // Find buffer indices
    var offset = 0;
    for (var i = 0; i < this.buffers.length; i++) {
      var buf = this.buffers[i];
      var next = offset + buf.length;

      // Found the start
      if (start >= offset && start <= next) {
        startIndex = i;
        startOffset = start - offset;
        if (endIndex !== -1)
          break;
      }
      if (end >= offset && end <= next) {
        endIndex = i;
        if (startIndex !== -1)
          break;
      }

      offset = next;
    }

    res.last = this.buffers[startIndex];
    res.offset = startOffset;
    res.maxSize = end - start;

    // Multi-buffer slice
    if (startIndex < endIndex) {
      res.sliceQueue = this.buffers.slice(startIndex + 1, endIndex + 1);

      res.last = res.last.slice(res.offset);
      res.offset = 0;
    }

    res.avail = res.last.length - res.offset;
    res.buffers.push(res.last);

    return res;
  };

  skip(n: number) {
    if (n === 0)
      return this.slice(this.size, this.size);

    this._ensure(n);

    var left = n;
    while (left > 0) {
      var toSkip = Math.min(left, this.avail);
      left -= toSkip;
      this.size += toSkip;
      if (toSkip === this.avail) {
        if (left !== 0) {
          this._next();
        } else {
          this.avail -= toSkip;
          this.offset += toSkip;
        }
      } else {
        this.offset += toSkip;
        this.avail -= toSkip;
      }
    }

    this._rangeCheck();

    return this.slice(this.size - n, this.size);
  };

  write(str: string) {
    // TODO: textencode?
    var len = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c > 255)
        len += 2;
      else
        len += 1;
    }
    this.reserve(len);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      var hi = c >>> 8;
      var lo = c & 0xff;

      if (hi)
        this.writeUInt8(hi);
      this.writeUInt8(lo);
    }
  };

  copyFrom(buf: Uint8Array, start?: number, end?: number) {
    var off = start === undefined ? 0 : start;
    var len = end === undefined ? buf.length : end;
    if (off === len)
      return;

    this._ensure(len - off);
    assert(this.last);
    while (off < len) {
      var toCopy = Math.min(len - off, this.avail);
      // buf.copy(this.last, this.offset, off, off + toCopy);
      this.last.set(buf.slice(off, off + toCopy), this.offset);
      off += toCopy;
      this.size += toCopy;
      if (toCopy === this.avail) {
        if (off !== len) {
          this._next();
        } else {
          this.avail = 0;
          this.offset += toCopy;
        }
      } else {
        this.offset += toCopy;
        this.avail -= toCopy;
      }
    }

    this._rangeCheck();
  };

  writeUInt8(v: number) {
    this._ensure(1);
    assert(this.last);

    this.last[this.offset++] = v;
    this.avail--;
    this._move(1);
  };

  writeUInt16BE(v: number) {
    this._ensure(2);
    assert(this.last);

    // Fast case - everything fits into the last buffer
    if (this.avail >= 2) {
      new DataView(this.last.buffer).setUint16(this.offset, v, false);
      this.offset += 2;
      this.avail -= 2;

    // One byte here, one byte there
    } else {
      this.last[this.offset] = (v >>> 8);
      this._next();
      this.last[this.offset++] = v & 0xff;
      this.avail--;
    }

    this._move(2);
  };

  writeUInt24BE(v: number) {
    this._ensure(3);
    assert(this.last);

    // Fast case - everything fits into the last buffer
    if (this.avail >= 3) {
      new DataView(this.last.buffer).setUint16(this.offset, v >>> 8, false);
      this.last[this.offset + 2] = v & 0xff;
      this.offset += 3;
      this.avail -= 3;
      this._move(3);

    // Two bytes here
    } else if (this.avail >= 2) {
      new DataView(this.last.buffer).setUint16(this.offset, v >>> 8, false);
      this._next();
      this.last[this.offset++] = v & 0xff;
      this.avail--;
      this._move(3);

    // Just one byte here
    } else {
      this.last[this.offset] = v >>> 16;
      this._move(1);
      this._next();
      this.writeUInt16BE(v & 0xffff);
    }
  };

  writeUInt32BE(v: number) {
    this._ensure(4);
    assert(this.last);

    // Fast case - everything fits into the last buffer
    if (this.avail >= 4) {
      new DataView(this.last.buffer).setUint32(this.offset, v, false);
      this.offset += 4;
      this.avail -= 4;
      this._move(4);

    // Three bytes here
    } else if (this.avail >= 3) {
      this.writeUInt24BE(v >>> 8);
      this._next();
      this.last[this.offset++] = v & 0xff;
      this.avail--;
      this._move(1);

    // Slow case, who cares
    } else {
      this.writeUInt16BE(v >>> 16);
      this.writeUInt16BE(v & 0xffff);
    }
  };

  writeUInt16LE(num: number) {
    var r = ((num & 0xff) << 8) | (num >>> 8);
    this.writeUInt16BE(r);
  };

  writeUInt24LE(num: number) {
    var r = ((num & 0xff) << 16) | (((num >>> 8) & 0xff) << 8) | (num >>> 16);
    this.writeUInt24BE(r);
  };

  writeUInt32LE(num: number) {
    this._ensure(4);
    assert(this.last);

    // Fast case - everything fits into the last buffer
    if (this.avail >= 4) {
      new DataView(this.last.buffer).setUint32(this.offset, num, false);
      this.offset += 4;
      this.avail -= 4;
      this._move(4);

    // Three bytes here
    } else if (this.avail >= 3) {
      this.writeUInt24LE(num & 0xffffff);
      this._next();
      this.last[this.offset++] = num >>> 24;
      this.avail--;
      this._move(1);

    // Slow case, who cares
    } else {
      this.writeUInt16LE(num & 0xffff);
      this.writeUInt16LE(num >>> 16);
    }
  };

  render() {
    var left = this.size;
    var out = [];

    for (var i = 0; i < this.buffers.length && left >= 0; i++) {
      var buf = this.buffers[i];
      left -= buf.length;
      if (left >= 0) {
        out.push(buf);
      } else {
        out.push(buf.slice(0, buf.length + left));
      }
    }

    return out;
  };

  // Signed APIs
  writeInt8(num: number) {
    if (num < 0)
      return this.writeUInt8(0x100 + num);
    else
      return this.writeUInt8(num);
  };

  writeInt16LE(num: number) {
    this.writeUInt16LE(toUnsigned16(num));
  };

  writeInt16BE(num: number) {
    this.writeUInt16BE(toUnsigned16(num));
  };

  writeInt24LE(num: number) {
    this.writeUInt24LE(toUnsigned24(num));
  };

  writeInt24BE(num: number) {
    this.writeUInt24BE(toUnsigned24(num));
  };

  writeInt32LE(num: number) {
    this.writeUInt32LE(toUnsigned32(num));
  };

  writeInt32BE(num: number) {
    this.writeUInt32BE(toUnsigned32(num));
  };

  writeComb(size: number, endian: 'le' | 'be', value: number) {
    if (size === 1)
      return this.writeUInt8(value);

    if (endian === 'le') {
      if (size === 2)
        this.writeUInt16LE(value);
      else if (size === 3)
        this.writeUInt24LE(value);
      else if (size === 4)
        this.writeUInt32LE(value);
    } else {
      if (size === 2)
        this.writeUInt16BE(value);
      else if (size === 3)
        this.writeUInt24BE(value);
      else if (size === 4)
        this.writeUInt32BE(value);
    }
  }
}

function toUnsigned16(num: number) {
  if (num < 0)
    return 0x10000 + num;
  else
    return num;
}

function toUnsigned24(num: number) {
  if (num < 0)
    return 0x1000000 + num;
  else
    return num;
}

function toUnsigned32(num: number) {
  if (num < 0)
    return (0xffffffff + num) + 1;
  else
    return num;
}
