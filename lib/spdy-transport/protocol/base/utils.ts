import { goaway } from "../spdy/constants.ts";
import { SpdyHeaders } from "../types.ts";

export class ProtocolError extends Error {
  code: keyof typeof goaway;
  constructor(code: keyof typeof goaway, message: string) {
    super(`${code}: ${message}`);
    console.error(`Building ProtocolError: ${code} ${message}`);
    this.code = code
    // this.message = message
  }
}

export function error (code: keyof typeof goaway, message: string) {
  return new ProtocolError(code, message)
}

export function reverse<T extends string> (object: Record<T,number>) {
  const result = new Array<T>()

  for (const key in object) {
    result[object[key] | 0] = key
  }

  return result
}

// weight [1, 36] <=> priority [0, 7]
// This way weight=16 is preserved and has priority=3
export function weightToPriority (weight: number) {
  return ((Math.min(35, (weight - 1)) / 35) * 7) | 0
}

export function priorityToWeight (priority: number) {
  return (((priority / 7) * 35) | 0) + 1
}

// Copy-Paste from node
export function addHeaderLine (field: string, value: string, dest: SpdyHeaders) {
  field = field.toLowerCase()
  if (/^:/.test(field)) {
    dest[field] = value
    return
  }

  switch (field) {
    // Array headers:
    case 'set-cookie':
      if (dest[field] !== undefined) {
        (dest[field] as string[]).push(value)
      } else {
        dest[field] = [ value ]
      }
      break

    /* eslint-disable max-len */
    // list is taken from:
    /* eslint-enable max-len */
    case 'content-type':
    case 'content-length':
    case 'user-agent':
    case 'referer':
    case 'host':
    case 'authorization':
    case 'proxy-authorization':
    case 'if-modified-since':
    case 'if-unmodified-since':
    case 'from':
    case 'location':
    case 'max-forwards':
      // drop duplicates
      if (dest[field] === undefined) {
        dest[field] = value
      }
      break

    case 'cookie':
      // make semicolon-separated list
      if (dest[field] !== undefined) {
        dest[field] += '; ' + value
      } else {
        dest[field] = value
      }
      break

    default:
      // make comma-separated list
      if (dest[field] !== undefined) {
        dest[field] += ', ' + value
      } else {
        dest[field] = value
      }
  }
}
