import { Decoder } from "./decoder.ts";
import { Table } from "./table.ts";
import { HpackHeader } from "./types.ts";
import { stringify } from "./utils.ts";

export class Decompressor {
  private _decoder: Decoder;
  private _table: Table;

  constructor(options: {
    table: ConstructorParameters<typeof Table>[0];
  }) {
    this._decoder = new Decoder();
    this._table = new Table(options.table);
  }

  transformOne(data: Uint8Array[]) {
    for (const x of data) {
      this._decoder.push(x);
    }

    const out: HpackHeader[] = [];
    while (!this._decoder.isEmpty()) {
      this._execute(out);
    }
    return out;
  };

  updateTableSize(size: number) {
    this._table.updateSize(size);
  };

  _execute(out: HpackHeader[]) {
    var isIndexed = this._decoder.decodeBit();
    if (isIndexed)
      return this._processIndexed(out);

    var isIncremental = this._decoder.decodeBit();
    var neverIndex = 0;
    if (!isIncremental) {
      var isUpdate = this._decoder.decodeBit();
      if (isUpdate)
        return this._processUpdate();

      neverIndex = this._decoder.decodeBit();
    }

    this._processLiteral(out, isIncremental, neverIndex);
  };

  _processIndexed(out: HpackHeader[]) {
    var index = this._decoder.decodeInt();

    var lookup = this._table.lookup(index);
    out.push({ name: lookup.name, value: lookup.value, neverIndex: false });
  };

  _processLiteral(out: HpackHeader[], inc: number, never: number) {
    var index = this._decoder.decodeInt();

    var name;
    var nameSize;

    // Literal header-name too
    if (index === 0) {
      name = this._decoder.decodeStr();
      nameSize = name.length;
      name = stringify(name);
    } else {
      var lookup = this._table.lookup(index);
      nameSize = lookup.nameSize;
      name = lookup.name;
    }

    var value = this._decoder.decodeStr();
    var valueSize = value.length;
    let valueStr = stringify(value);

    if (inc)
      this._table.add(name, valueStr, nameSize, valueSize);

    out.push({ name: name, value: valueStr, neverIndex: never !== 0});
  };

  _processUpdate() {
    var size = this._decoder.decodeInt();
    this.updateTableSize(size);
  };
}
