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
  constructor (compression: boolean) {
    this.compression = compression
  }

  static create (compression: boolean) {
    return new CompressionPool(compression)
  }

  get (version: 2|3|3.1) {
    return {
      version: version,
      compress: _createDeflate(version, this.compression),
      decompress: _createInflate(version),
    }
  }

  put (pair: CompressionPair) {
    pair.compress.close();
    pair.decompress.close();
  }
}
