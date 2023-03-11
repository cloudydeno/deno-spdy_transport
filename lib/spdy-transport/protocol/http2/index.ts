export const name = 'http2'

// export { dictionary } from './dictionary.ts'
export * as constants from './constants.ts'
export { Parser as parser } from './parser.ts'
export { Framer as framer } from './framer.ts'
// export { CompressionPool as compressionPool } from './hpack-pool.ts'
export const compressionPool = null;
