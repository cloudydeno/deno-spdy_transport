import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { Encoder } from "./encoder.ts";
import { Table } from "./table.ts";
import { HpackHeader } from "./types.ts";
import { toArray } from "./utils.ts";

export class Compressor {
  _encoder: Encoder | null = null;
  _table: Table;
  // stream: TransformStream<HpackHeader[],Uint8Array[]>;

  constructor(options: {
    table: ConstructorParameters<typeof Table>[0];
  }) {
    this._encoder = null;
    this._table = new Table(options.table);
    // this.stream = new TransformStream(this);
  }

  transformOne(data: HpackHeader[]) {
    assert(Array.isArray(data), 'Compressor.write() expects list of headers');

    this._encoder = new Encoder();
    for (var i = 0; i < data.length; i++)
      this._encodeHeader(data[i]);

    var bufs = this._encoder.render();
    this._encoder = null;

    return bufs;
  }

  updateTableSize(size: number) {
    var data: Uint8Array[] = [];
    if (size >= this._table.protocolMaxSize) {
      size = this._table.protocolMaxSize;

      var enc = new Encoder();

      // indexed = 0
      // incremental = 0
      // update = 1
      enc.encodeBits(1, 3);
      enc.encodeInt(size);

      data = enc.render();
      // for (var i = 0; i < data.length; i++)
      //   this.push(data[i]);
    }

    this._table.updateSize(size);
    return data;
  };

  reset() {
    var enc = new Encoder();
    var size = this._table.maxSize;

    // indexed = 0
    // incremental = 0
    // update = 1
    enc.encodeBits(1, 3);
    enc.encodeInt(0);

    // Evict everything
    this._table.updateSize(0);

    // indexed = 0
    // incremental = 0
    // update = 1
    enc.encodeBits(1, 3);
    enc.encodeInt(size);

    // Revert size
    this._table.updateSize(size);

    var data = enc.render();
    return data;
    // for (var i = 0; i < data.length; i++)
    //   this.push(data[i]);
  };

  _encodeHeader(header: HpackHeader) {
    if (header.neverIndex) {
      var index = 0;
      var neverIndex = 1;
      var isIndexed = 0;
      var isIncremental = 0;
    } else {
      var index = this._table.reverseLookup(header.name, header.value);
      var isIndexed = index > 0 ? 1 : 0;
      var isIncremental = header.incremental !== false ? 1 : 0;
      var neverIndex = 0;
    }

    assert(this._encoder);
    this._encoder.encodeBit(isIndexed);
    if (isIndexed) {
      this._encoder.encodeInt(index);
      return;
    }

    var name = toArray(header.name);
    var value = toArray(header.value);

    this._encoder.encodeBit(isIncremental);
    if (isIncremental) {
      this._table.add(header.name, header.value, name.length, value.length);
    } else {
      // Update = false
      this._encoder.encodeBit(0);
      this._encoder.encodeBit(neverIndex);
    }

    // index is negative for `name`-only headers
    this._encoder.encodeInt(-index);
    if (index === 0)
      this._encoder.encodeStr(name, header.huffman !== false);
    this._encoder.encodeStr(value, header.huffman !== false);
  };
}
