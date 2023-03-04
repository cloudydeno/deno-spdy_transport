export const name = 'spdy'

export { dictionary } from './dictionary.ts'
export * as constants from './constants.ts'
export { Parser as parser } from './parser.ts'
export { Framer as framer } from './framer.ts'
export { CompressionPool as compressionPool } from './zlib-pool.ts'
