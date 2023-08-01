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

    const options = {
      table: {
        maxSize: HEADER_TABLE_SIZE
      }
    }

    const compress = new Compressor(options)
    const decompress = new Decompressor(options)

    return {
      version: version,
      compress,
      decompress,
    }
  }

  put () {
  }
}
