import { WriteBuffer } from "../wbuf.ts";
import { encode as huffman } from './huffman.ts';

export class Encoder {
  buffer = new WriteBuffer;
  word = 0;
  bitOffset = 0;

  render() {
    return this.buffer.render();
  };

  encodeBit(bit: number) {
    var octet;

    this.word <<= 1;
    this.word |= bit;
    this.bitOffset++;

    if (this.bitOffset === 8) {
      this.buffer.writeUInt8(this.word);
      this.word = 0;
      this.bitOffset = 0;
    }
  };

  encodeBits(bits: number, len: number) {
    var left = bits;
    var leftLen = len;

    while (leftLen > 0) {
      var avail = Math.min(leftLen, 8 - this.bitOffset);
      var toWrite = left >>> (leftLen - avail);

      if (avail === 8) {
        this.buffer.writeUInt8(toWrite);
      } else {
        this.word <<= avail;
        this.word |= toWrite;
        this.bitOffset += avail;
        if (this.bitOffset === 8) {
          this.buffer.writeUInt8(this.word);
          this.word = 0;
          this.bitOffset = 0;
        }
      }

      leftLen -= avail;
      left &= (1 << leftLen) - 1;
    }
  };

  // Just for testing
  skipBits(num: number) {
    this.bitOffset += num;
    this.buffer.skip(this.bitOffset >> 3);
    this.bitOffset &= 0x7;
  };

  encodeInt(num: number) {
    debugger;
    var prefix = 8 - this.bitOffset;

    // We are going to end up octet-aligned
    this.bitOffset = 0;

    var max = (1 << prefix) - 1;

    // Fast case - int fits into the prefix
    if (num < max) {
      this.buffer.writeUInt8((this.word << prefix) | num);
      // return octet;
      return;
    }

    var left = num - max;
    this.buffer.writeUInt8((this.word << prefix) | max);
    do {
      var octet = left & 0x7f;
      left >>= 7;
      if (left !== 0)
        octet |= 0x80;

      this.buffer.writeUInt8(octet);
    } while (left !== 0);
  };

  encodeStr(value: number[], isHuffman: boolean) {
    this.encodeBit(isHuffman ? 1 : 0);

    if (!isHuffman) {
      this.buffer.reserve(value.length + 1);
      this.encodeInt(value.length);
      for (var i = 0; i < value.length; i++)
        this.buffer.writeUInt8(value[i]);
      return;
    }

    var codes = [];
    var len = 0;
    var pad = 0;

    for (var i = 0; i < value.length; i++) {
      var code = huffman[value[i]];
      codes.push(code);
      len += code[0];
    }
    if (len % 8 !== 0)
      pad = 8 - (len % 8);
    len += pad;

    this.buffer.reserve((len / 8) + 1);
    this.encodeInt(len / 8);
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      this.encodeBits(code[1], code[0]);
    }

    // Append padding
    this.encodeBits(0xff >>> (8 - pad), pad);
  };
}
