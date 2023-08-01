import { Framer as BaseFramer, FramerOptions } from "../base/framer.ts"
import * as constants from "./constants.ts"
import { DEFAULT_HOST, DEFAULT_METHOD } from "../base/constants.ts"
import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts"
import { PriorityFrame, SpdyHeaders } from '../types.ts'
import { WriteBuffer } from "../../../wbuf.ts";
import { PriorityJson } from "../../priority.ts";
import { WritableData } from '../base/scheduler.ts'
import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts'
import { OffsetBuffer } from "../../../obuf.ts";
import { HpackHeader } from "../../../hpack/types.ts";
import { Compressor } from "../../../hpack/compressor.ts";

type FrameIds = {
  type: keyof typeof constants.frameType;
  id: number;
  flags: number;
  priority?: false | number;
}

export type Http2RequestOptions = {
  id: number;
  method?: string;
  path?: string;
  host?: string;
  priority?: PriorityJson;
  headers: SpdyHeaders,
  fin?: boolean;

  // version?: string;
  scheme?: string;
  status?: number;
  // associated?: number;
  promisedId: number;
}

export class Framer extends BaseFramer {
  maxFrameSize = constants.INITIAL_MAX_FRAME_SIZE
  constructor (options: FramerOptions) {
    super(options)
  }

  hpackCompressor = new Compressor({
    table: {
      maxSize: constants.HEADER_TABLE_SIZE
    }
  })

  setMaxFrameSize (size: number) {
    this.maxFrameSize = size
  }

  async _frame (frame: FrameIds, body: (buf: WriteBuffer) => void) {
    // debug('id=%d type=%s', frame.id, frame.type)

    const buffer = new WriteBuffer()

    buffer.reserve(constants.FRAME_HEADER_SIZE)
    const len = buffer.skip(3)
    buffer.writeUInt8(constants.frameType[frame.type])
    buffer.writeUInt8(frame.flags)
    buffer.writeUInt32BE(frame.id & 0x7fffffff)

    body(buffer)

    const frameSize = buffer.size - constants.FRAME_HEADER_SIZE
    len.writeUInt24BE(frameSize)

    const chunks = buffer.render()
    assertEquals(typeof frame.id, "number");

    if (this.window && frame.type === 'DATA') {
      this._resetTimeout()
      await new Promise(ok => this.window.send.update(-frameSize, ok));
    }

    await new Promise(ok => {
      const toWrite: WritableData = {
        stream: frame.id,
        priority: frame.priority ?? false,
        chunks: chunks,
        callback: ok,
      }

      this._resetTimeout()
      this.schedule(toWrite)
    });

    return chunks
  }

  _split (frame: {
    chunks: Uint8Array[];
    reserve: number;
  }) {
    const buf = new OffsetBuffer()
    for (let i = 0; i < frame.chunks.length; i++) { buf.push(frame.chunks[i]) }

    const frames = new Array<{
      chunks: Uint8Array[];
      size: number;
    }>();
    while (!buf.isEmpty()) {
      // First frame may have reserved bytes in it
      let size = this.maxFrameSize
      if (frames.length === 0) {
        size -= frame.reserve
      }
      size = Math.min(size, buf.size)

      const frameBuf = buf.clone(size)
      buf.skip(size)

      frames.push({
        size: frameBuf.size,
        chunks: frameBuf.toChunks()
      })
    }

    return frames
  }

  async _continuationFrame(
    frame: {
      id: number;
      flags: number;
      type: keyof typeof constants.frameType;
      chunks: Uint8Array[];
      reserve: number;
    },
    body: (buf: WriteBuffer) => void,
    // callback,
  ) {
    const frames = this._split(frame)

    let promise: Promise<unknown> | null = null;
    for (const [i, subFrame] of frames.entries()) {
      const isFirst = i === 0
      const isLast = i === frames.length - 1

      let flags = isLast ? constants.flags.END_HEADERS : 0

      // PRIORITY and friends
      if (isFirst) {
        flags |= frame.flags
      }

      promise = this._frame({
        id: frame.id,
        priority: false,
        type: isFirst ? frame.type : 'CONTINUATION',
        flags: flags
      }, function (buf) {
        // Fill those reserved bytes
        if (isFirst && body) { body(buf) }

        buf.reserve(subFrame.size)
        for (let i = 0; i < subFrame.chunks.length; i++) {
          buf.copyFrom(subFrame.chunks[i])
        }
      })
    }
    await promise;

    if (frames.length === 0) {
      await this._frame({
        id: frame.id,
        priority: false,
        type: frame.type,
        flags: frame.flags | constants.flags.END_HEADERS
      }, function (buf) {
        if (body) { body(buf) }
      })
    }
  }

  _compressHeaders(headers: SpdyHeaders, pairs: HpackHeader[]) {
    for (const [name, value] of Object.entries(headers)) {
      const lowName = name.toLowerCase()

      // Not allowed in HTTP2
      switch (lowName) {
        case 'host':
        case 'connection':
        case 'keep-alive':
        case 'proxy-connection':
        case 'transfer-encoding':
        case 'upgrade':
          break;
      }

      // Should be in `pairs`
      if (/^:/.test(lowName)) {
        break;
      }

      // Do not compress, or index Cookie field (for security reasons)
      const neverIndex = lowName === 'cookie' || lowName === 'set-cookie'

      if (Array.isArray(value)) {
        for (const subValue of value) {
          pairs.push({
            name: lowName,
            value: subValue + '',
            neverIndex: neverIndex,
            huffman: !neverIndex
          })
        }
      } else {
        pairs.push({
          name: lowName,
          value: value + '',
          neverIndex: neverIndex,
          huffman: !neverIndex
        })
      }
    }

    // assert(this.compress !== null, 'Framer version not initialized')
    // debugExtra('compressing headers=%j', pairs)
    return this.hpackCompressor.transformOne(pairs)
  }

  _isDefaultPriority(priority?: PriorityJson) {
    if (!priority) { return true }

    return !priority.parent &&
          // the constant was DEFAULT which didn't exist
          priority.weight === constants.DEFAULT_WEIGHT &&
          !priority.exclusive
  }

  _defaultHeaders(frame: Http2RequestOptions, pairs: HpackHeader[]) {
    if (!frame.path) {
      throw new Error('`path` is required frame argument')
    }

    pairs.push({
      name: ':method',
      value: frame.method || DEFAULT_METHOD
    })
    pairs.push({ name: ':path', value: frame.path })
    pairs.push({ name: ':scheme', value: frame.scheme || 'https' })
    pairs.push({
      name: ':authority',
      value: frame.host ||
            (frame.headers?.host ? `${frame.headers.host}` : '') ||
            DEFAULT_HOST
    })
  }

  async _headersFrame(kind: 'request' | 'response' | 'headers', frame: Http2RequestOptions) {
    const pairs: HpackHeader[] = []

    if (kind === 'request') {
      this._defaultHeaders(frame, pairs)
    } else if (kind === 'response') {
      pairs.push({ name: ':status', value: (frame.status || 200) + '' })
    }

    const chunks = this._compressHeaders(frame.headers, pairs);

    let reserve = 0

    // If priority info is present, and the values are not default ones
    // reserve space for the priority info and add PRIORITY flag
    const priority = frame.priority
    if (!this._isDefaultPriority(priority)) { reserve = 5 }

    let flags = reserve === 0 ? 0 : constants.flags.PRIORITY

    // Mostly for testing
    if (frame.fin) {
      flags |= constants.flags.END_STREAM
    }

    await this._continuationFrame({
      id: frame.id,
      type: 'HEADERS',
      flags: flags,
      reserve: reserve,
      chunks: chunks
    }, function (buf) {
      if (reserve === 0) {
        return
      }
      assert(priority, 'has priority');

      buf.writeUInt32BE(((priority.exclusive ? 0x80000000 : 0) |
                        (priority.parent || 0)) >>> 0)
      buf.writeUInt8((priority.weight | 0) - 1)
    })
  }

  requestFrame(frame: Http2RequestOptions) {
    return this._headersFrame('request', frame)
  }

  responseFrame(frame: Http2RequestOptions) {
    return this._headersFrame('response', frame)
  }

  headersFrame(frame: Http2RequestOptions) {
    return this._headersFrame('headers', frame)
  }

  async pushFrame(frame: Http2RequestOptions & {response?: SpdyHeaders}) {
    await this._checkPush();

    const pairs = {
      promise: new Array<HpackHeader>(),
      response: new Array<HpackHeader>(),
    }

    this._defaultHeaders(frame, pairs.promise)
    pairs.response.push({ name: ':status', value: (frame.status || 200) + '' })

    const promiseChunks = this._compressHeaders(frame.headers, pairs.promise);
    await this._continuationFrame({
      id: frame.id,
      type: 'PUSH_PROMISE',
      reserve: 4,
      flags: 0,
      chunks: promiseChunks
    }, function (buf) {
      buf.writeUInt32BE(frame.promisedId)
    })

    if (frame.response) {
      const responseChunks = this._compressHeaders(frame.response, pairs.response);
      const priority = frame.priority
      const isDefaultPriority = this._isDefaultPriority(priority)
      let flags = isDefaultPriority ? 0 : constants.flags.PRIORITY

      // Mostly for testing
      if (frame.fin) {
        flags |= constants.flags.END_STREAM
      }

      await this._continuationFrame({
        id: frame.promisedId,
        type: 'HEADERS',
        flags: flags,
        reserve: isDefaultPriority ? 0 : 5,
        chunks: responseChunks
      }, function (buf) {
        if (isDefaultPriority) {
          return
        }
        assert(priority, 'has priority');

        buf.writeUInt32BE((priority.exclusive ? 0x80000000 : 0) |
                          (priority.parent ?? 0))
        buf.writeUInt8((priority.weight | 0) - 1)
      })
    }
  }

  async priorityFrame (frame: PriorityFrame) {
    await this._frame({
      id: frame.id,
      priority: false,
      type: 'PRIORITY',
      flags: 0
    }, function (buf) {
      const priority = frame.priority
      buf.writeUInt32BE((priority.exclusive ? 0x80000000 : 0) |
                        priority.parent)
      buf.writeUInt8((priority.weight | 0) - 1)
    })
  }

  async dataFrame (frame: {
    id: number;
    fin: boolean;
    data: Uint8Array;
    priority: false | number;
  }) {
    const frames = this._split({
      reserve: 0,
      chunks: [ frame.data ]
    })

    const fin = frame.fin ? constants.flags.END_STREAM : 0

    for (const [i, subFrame] of frames.entries()) {
      const isLast = i === frames.length - 1
      let flags = 0
      if (isLast) {
        flags |= fin
      }

      await this._frame({
        id: frame.id,
        priority: frame.priority,
        type: 'DATA',
        flags: flags
      }, function (buf) {
        buf.reserve(subFrame.size)
        for (let i = 0; i < subFrame.chunks.length; i++) { buf.copyFrom(subFrame.chunks[i]) }
      })
    }

    // Empty DATA
    if (frames.length === 0) {
      await this._frame({
        id: frame.id,
        priority: frame.priority,
        type: 'DATA',
        flags: fin
      }, function () {
        // No-op
      })
    }
  }

  async pingFrame (frame: {
    opaque: Uint8Array,
    ack: boolean;
  }) {
    await this._frame({
      type: 'PING',
      id: 0,
      flags: frame.ack ? constants.flags.ACK : 0,
    }, function (buf) {
      buf.copyFrom(frame.opaque)
    })
  }

  async rstFrame (frame: {
    id: number;
    code: keyof typeof constants.error;
  }) {
    await this._frame({
      type: 'RST_STREAM',
      id: frame.id,
      flags: 0
    }, function (buf) {
      buf.writeUInt32BE(constants.error[frame.code])
    })
  }

  async prefaceFrame () {
    // debug('preface')
    this._resetTimeout()
    await new Promise(ok => this.schedule({
      stream: 0,
      priority: false,
      chunks: [ constants.PREFACE_BUFFER ],
      callback: ok
    }))
  }

  async settingsFrame (options: Partial<Record<constants.SettingsKey,number>>) {
    const key = JSON.stringify(options)

    const settings = Framer.settingsCache[key]
    if (settings) {
      // debug('cached settings')
      this._resetTimeout()
      await new Promise(ok => this.schedule({
        stream: 0,
        priority: false,
        chunks: settings,
        callback: ok,
      }));
      return
    }

    const params: Array<{key: number, value: number}> = []
    for (let i = 0; i < constants.settingsIndex.length; i++) {
      const name = constants.settingsIndex[i]
      if (!name) { continue }

      const value = options[name];
      if (value !== undefined) {
        // value: Infinity
        if (!isFinite(value)) {
          continue
        }

        params.push({ key: i, value: value })
      }
    }

    const bodySize = params.length * 6

    const frame = await this._frame({
      type: 'SETTINGS',
      id: 0,
      flags: 0
    }, function (buffer) {
      buffer.reserve(bodySize)
      for (let i = 0; i < params.length; i++) {
        const param = params[i]

        buffer.writeUInt16BE(param.key)
        buffer.writeUInt32BE(param.value)
      }
    })

    if (frame) {
      Framer.settingsCache[key] = frame
    }
  }

  async ackSettingsFrame () {
    await this._frame({
      id: 0,
      type: 'SETTINGS',
      flags: constants.flags.ACK
    }, function () {
      // No-op
    })
  }

  async windowUpdateFrame (frame: {
    id: number;
    delta: number;
  }) {
    await this._frame({
      type: 'WINDOW_UPDATE',
      id: frame.id,
      flags: 0
    }, function (buf) {
      buf.reserve(4)
      buf.writeInt32BE(frame.delta)
    })
  }

  async goawayFrame (frame: {
    lastId: number;
    code: keyof typeof constants.goaway;
    extra?: string; // TODO: not written
  }) {
    await this._frame({
      type: 'GOAWAY',
      id: 0,
      flags: 0
    }, function (buf) {
      buf.reserve(8)

      // Last-good-stream-ID
      buf.writeUInt32BE(frame.lastId & 0x7fffffff)
      // Code
      buf.writeUInt32BE(constants.goaway[frame.code])

      // Extra debugging information
      if (frame.extra) {
        buf.write(frame.extra)
      }
    })
  }

  async xForwardedFor (frame: {host: string}) {
    await this._frame({
      type: 'X_FORWARDED_FOR',
      id: 0,
      flags: 0
    }, function (buf) {
      buf.write(frame.host)
    })
  }

  static settingsCache: Record<string, Uint8Array[]> = {};
}
