import { HEADER_TABLE_SIZE } from "./constants.ts";
import { Compressor } from "../../../hpack/compressor.ts"
import { Decompressor } from "../../../hpack/decompressor.ts"

export type CompressionPair = {
  version: 4;
  compress: Compressor;
  decompress: Decompressor;
};

export class CompressionPool {

  get (version: 2 | 3 | 3.1 | 4) {

    var options = {
      table: {
        maxSize: HEADER_TABLE_SIZE
      }
    }

    var compress = new Compressor(options)
    var decompress = new Decompressor(options)

    return {
      version: version,
      compress,
      decompress,
    }
  }

  put () {
  }
}
