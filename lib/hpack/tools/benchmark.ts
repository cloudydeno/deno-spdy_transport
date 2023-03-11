#!/usr/bin/env -S deno run

import { Compressor } from "../compressor.ts";
import { Decompressor } from "../decompressor.ts";

const options = {
  table: { maxSize: 1024 }
};

const compressor = new Compressor(options);

const vector = [];
for (let i = 0; i < 1024; i++) {
  vector.push({
    name: 'kind-of-big-header-name__',
    value: 'not-so-small value yes!',
    huffman: true,
    neverIndex: true
  });
}
const input = compressor.transformOne(vector);

console.time('decompressor');
for (let i = 0; i < 2000; i++) {
  const decompressor = new Decompressor(options);
  decompressor.transformOne(input);
}
console.timeEnd('decompressor');
