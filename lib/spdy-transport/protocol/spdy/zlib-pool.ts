import { createDeflate,constants,createInflate, Deflate, Inflate } from 'node:zlib';
import { dictionary } from "./dictionary.ts";

// TODO(indutny): think about it, why has it always been Z_SYNC_FLUSH here.
// It should be possible to manually flush stuff after the write instead
function _createDeflate (version: 2|3|3.1, compression: boolean) {
  const deflate = createDeflate({
    dictionary: dictionary[version],
    flush: constants.Z_SYNC_FLUSH,
    windowBits: 11,
    level: compression ? constants.Z_DEFAULT_COMPRESSION : constants.Z_NO_COMPRESSION
  })

  return deflate
}

function _createInflate (version: 2|3|3.1) {
  const inflate = createInflate({
    dictionary: dictionary[version],
    flush: constants.Z_SYNC_FLUSH
  })

  return inflate
}

export type CompressionPair = {
  version: 2 | 3 | 3.1;
  compress: Deflate;
  decompress: Inflate;
};

export class CompressionPool {
  compression: boolean;
  pool: { 2: CompressionPair[]; 3: CompressionPair[]; 3.1: CompressionPair[]; };
  constructor (compression: boolean) {
    this.compression = compression
    this.pool = {
      2: [],
      3: [],
      3.1: []
    }
  }

  static create (compression: boolean) {
    return new CompressionPool(compression)
  }

  get (version: 2|3|3.1) {
    if (this.pool[version].length > 0) {
      return this.pool[version].pop()!
    } else {
      const id = version

      return {
        version: version,
        compress: _createDeflate(id, this.compression),
        decompress: _createInflate(id),
      }
    }
  }

  put (pair: CompressionPair) {
    this.pool[pair.version].push(pair)
  }
}
