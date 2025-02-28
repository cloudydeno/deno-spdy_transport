import { OffsetBuffer } from "../obuf.ts";
import { decode as huffman, HuffmanDecodeNode } from './huffman.ts';
import { assert } from "./utils.ts";

export class Decoder {
  buffer = new OffsetBuffer();
  bitOffset = 0;

  // Used internally in decodeStr
  _huffmanNode: HuffmanDecodeNode[] | null = null;

  isEmpty() {
    return this.buffer.isEmpty();
  };

  push(chunk: Uint8Array) {
    this.buffer.push(chunk);
  };

  decodeBit() {
    // Need at least one octet
    assert(this.buffer.has(1), 'Buffer too small for an int');

    var octet;
    var offset = this.bitOffset;

    if (++this.bitOffset === 8) {
      octet = this.buffer.readUInt8();
      this.bitOffset = 0;
    } else {
      octet = this.buffer.peekUInt8();
    }
    return (octet >>> (7 - offset)) & 1;
  };

  // Just for testing
  skipBits(n: number) {
    this.bitOffset += n;
    this.buffer.skip(this.bitOffset >> 3);
    this.bitOffset &= 0x7;
  };

  decodeInt() {
    // Need at least one octet
    assert(this.buffer.has(1), 'Buffer too small for an int');

    var prefix = 8 - this.bitOffset;

    // We are going to end up octet-aligned
    this.bitOffset = 0;

    var max = (1 << prefix) - 1;
    var octet = this.buffer.readUInt8() & max;

    // Fast case - int fits into the prefix
    if (octet !== max)
      return octet;

    // TODO(indutny): what about > 32bit numbers?
    var res = 0;
    var isLast = false;
    var len = 0;
    do {
      octet = this.buffer.readUInt8();
      isLast = (octet & 0x80) === 0;

      res <<= 7;
      res |= octet & 0x7f;
      len++;
    } while (!isLast);
    assert(isLast, 'Incomplete data for multi-octet integer');
    assert(len <= 4, 'Integer does not fit into 32 bits');

    // Reverse bits
    res = (res >>> 21) |
          (((res >> 14) & 0x7f) << 7) |
          (((res >> 7) & 0x7f) << 14) |
          ((res & 0x7f) << 21);
    res >>= (4 - len) * 7;

    // Append prefix max
    res += max;

    return res;
  };

  decodeHuffmanWord(input: number,
                                                                  inputBits: number,
                                                                  out: number[]) {
    var root = huffman;
    var node = this._huffmanNode!;
    var word = input;
    var bits = inputBits;

    for (; bits > 0; word &= (1 << bits) - 1) {
      // Nudge the word bit length to match it
      var subnode: HuffmanDecodeNode | null = null;
      for (var i = Math.max(0, bits - 8); i < bits; i++) {
        subnode = node[word >>> i];
        if (typeof subnode !== 'number') {
          node = subnode;
          bits = i;
          break;
        }

        if (subnode === 0)
          continue;

        // Word bit length should match
        if ((subnode >>> 9) !== bits - i) {
          subnode = 0;
          continue;
        }

        var octet = subnode & 0x1ff;
        assert(octet !== 256, 'EOS in encoding');
        out.push(octet);
        node = root;

        bits = i;
        break;
      }
      if (subnode === 0)
        break;
    }
    this._huffmanNode = node;

    return bits;
  };

  decodeStr() {
    var isHuffman = this.decodeBit();
    var len = this.decodeInt();
    assert(this.buffer.has(len), 'Not enough octets for string');

    if (!isHuffman)
      return [...this.buffer.take(len)];

    this._huffmanNode = huffman;

    var out: number[] = [];

    var word = 0;
    var bits = 0;
    var lastKey = 0;
    for (var i = 0; i < len; i++) {
      word <<= 8;
      word |= this.buffer.readUInt8();
      bits += 8;

      bits = this.decodeHuffmanWord(word, bits, out);
      lastKey = word >> bits;
      word &= (1 << bits) - 1;
    }
    assert(this._huffmanNode === huffman, '8-bit EOS');
    assert(word + 1 === (1 << bits), 'Final sequence is not EOS');

    this._huffmanNode = null;

    return out;
  };
}
