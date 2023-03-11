import { staticTable } from "./static-table.ts";
import { assert } from "./utils.ts";

export class Table {
  static = staticTable;
  dynamic: typeof staticTable.table = [];
  size = 0;
  maxSize = 0;
  length = this.static.table.length;
  protocolMaxSize: number;
  lookupDepth: number;

  constructor(options: {
    maxSize: number;
    lookupDepth?: number;
  }) {
    this.protocolMaxSize = options.maxSize;
    this.maxSize = options.maxSize;
    this.lookupDepth = options.lookupDepth || 32;
  }

  lookup(index: number) {
    assert(index !== 0, 'Zero indexed field');
    assert(index <= this.length, 'Indexed field OOB')

    if (index <= this['static'].table.length)
      return this['static'].table[index - 1];
    else
      return this.dynamic[this.length - index];
  };

  reverseLookup(name: string, value: string): number {
    var staticEntry = this['static'].map[name];
    if (staticEntry && staticEntry.values[value])
      return staticEntry.values[value]!;

    // Reverse search dynamic table (new items are at the end of it)
    var limit = Math.max(0, this.dynamic.length - this.lookupDepth);
    for (var i = this.dynamic.length - 1; i >= limit; i--) {
      var entry = this.dynamic[i];
      if (entry.name === name && entry.value === value)
        return this.length - i;

      if (entry.name === name) {
        // Prefer smaller index
        if (staticEntry)
          break;
        return -(this.length - i);
      }
    }

    if (staticEntry)
      return -staticEntry.index;

    return 0;
  };

  add(name: string, value: string, nameSize: number, valueSize: number) {
    var totalSize = nameSize + valueSize + 32;

    this.dynamic.push({
      name: name,
      value: value,
      nameSize: nameSize,
      totalSize: totalSize
    });
    this.size += totalSize;
    this.length++;

    this.evict();
  };

  evict() {
    while (this.size > this.maxSize) {
      var entry = this.dynamic.shift()!;
      this.size -= entry.totalSize;
      this.length--;
    }
    assert(this.size >= 0, 'Table size sanity check failed');
  };

  updateSize(size: number) {
    assert(size <= this.protocolMaxSize, 'Table size bigger than maximum');
    this.maxSize = size;
    this.evict();
  };
}
