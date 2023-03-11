'use strict'

import { Buffer } from 'node:buffer'
import { Framer as BaseFramer, FramerOptions } from "../base/framer.ts"
import * as constants from "./constants.ts"
import { DEFAULT_HOST, DEFAULT_METHOD } from "../base/constants.ts"
import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts"
import { weightToPriority } from "../base/utils.ts"
import { ClassicCallback, SpdySettingsKey, SpdyHeaders, SpdyHeaderValue } from '../types.ts'
import { WriteBuffer } from "../../../wbuf.ts";
import { PriorityJson } from "../../priority.ts";
import { WritableData } from '../base/scheduler.ts'
import { assertEquals } from 'https://deno.land/std@0.170.0/testing/asserts.ts'
// var debug = require('debug')('spdy:framer')

type FrameIds = {
  type: keyof typeof constants.frameType;
  id: number;
  flags: number;
  priority?: boolean;
}

export type SpdyRequestOptions = {
  id: number;
  method: string;
  path?: string;
  host?: string;
  priority: PriorityJson;
  headers: SpdyHeaders,
  fin?: boolean;

  version?: string;
  scheme?: string;
  status?: number;
  associated?: number;
}

export class Framer extends BaseFramer {
  constructor (options: FramerOptions) {
    super(options)
  }

  static create (options: FramerOptions) {
    return new Framer(options)
  }

  setMaxFrameSize (size: number) {
    // http2-only
  }

  async headersToDict (headers: SpdyHeaders, preprocess: null | ((headers: SpdyHeaders) => void)) {
    function stringify (value: SpdyHeaderValue | undefined) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          return value.join('\x00')
        } else if (typeof value === 'string') {
          return value
        } else {
          return value.toString()
        }
      } else {
        return ''
      }
    }

    // Lower case of all headers keys
    var loweredHeaders: SpdyHeaders = {}
    Object.keys(headers || {}).map(function (key) {
      loweredHeaders[key.toLowerCase()] = headers[key]
    })

    // Allow outer code to add custom headers or remove something
    if (preprocess) { preprocess(loweredHeaders) }

    // Transform object into kv pairs
    var size = this.version === 2 ? 2 : 4
    var len = size
    var pairs = Object.keys(loweredHeaders).filter((key) => {
      var lkey = key.toLowerCase()

      // Will be in `:host`
      if (lkey === 'host' && (this.version ?? 0) >= 3) {
        return false
      }

      return lkey !== 'connection' && lkey !== 'keep-alive' &&
            lkey !== 'proxy-connection' && lkey !== 'transfer-encoding'
    }, this).map(function (key) {
      var klen = Buffer.byteLength(key)
      var value = stringify(loweredHeaders[key])
      var vlen = Buffer.byteLength(value)

      len += size * 2 + klen + vlen
      return [klen, key, vlen, value] as const
    })

    var block = new WriteBuffer()
    block.reserve(len)

    if (this.version === 2) {
      block.writeUInt16BE(pairs.length)
    } else {
      block.writeUInt32BE(pairs.length)
    }

    pairs.forEach((pair) => {
      // Write key length
      if (this.version === 2) {
        block.writeUInt16BE(pair[0])
      } else {
        block.writeUInt32BE(pair[0])
      }

      // Write key
      block.write(pair[1])

      // Write value length
      if (this.version === 2) {
        block.writeUInt16BE(pair[2])
      } else {
        block.writeUInt32BE(pair[2])
      }
      // Write value
      block.write(pair[3])
    }, this)

    assert(this.compress !== null, 'Framer version not initialized')
    const chunks = await new Promise<Uint8Array[]>((ok, fail) => {
      this.compress!.write(block.render(), (err, out) => err ? fail(err) : ok(out!));
    });
    return chunks;
  }

  async _frame (frame: FrameIds, body: (buf: WriteBuffer) => void) {
    if (!this.version) {
      console.error('hmm 2')
      await new Promise(ok => this.once('version', ok));
      assert(this.version);
    }

    // debug('id=%d type=%s', frame.id, frame.type)

    var buffer = new WriteBuffer()

    buffer.writeUInt16BE(0x8000 | this.version)
    buffer.writeUInt16BE(constants.frameType[frame.type] ?? 0)
    buffer.writeUInt8(frame.flags ?? 0)
    var len = buffer.skip(3)

    body(buffer)

    var frameSize = buffer.size - constants.FRAME_HEADER_SIZE
    len.writeUInt24BE(frameSize)

    var chunks = buffer.render()
    assertEquals(typeof frame.id, "number");
    await new Promise(ok => {
      var toWrite: WritableData = {
        stream: frame.id,
        priority: false,
        chunks: chunks,
        callback: ok
      }

      this._resetTimeout()
      this.schedule(toWrite)
    });

    return chunks
  }

  async _synFrame (frame: SpdyRequestOptions) {
    var self = this

    if (!frame.path) {
      throw new Error('`path` is required frame argument')
    }

    function preprocess (headers: SpdyHeaders) {
      var method = frame.method || DEFAULT_METHOD
      var version = frame.version || 'HTTP/1.1'
      var scheme = frame.scheme || 'https'
      var host = frame.host ||
                (frame.headers && frame.headers.host) ||
                DEFAULT_HOST

      if (self.version === 2) {
        headers.method = method
        headers.version = version
        headers.url = frame.path
        headers.scheme = scheme
        headers.host = host
        if (frame.status) {
          headers.status = frame.status
        }
      } else {
        headers[':method'] = method
        headers[':version'] = version
        headers[':path'] = frame.path
        headers[':scheme'] = scheme
        headers[':host'] = host
        if (frame.status) { headers[':status'] = frame.status }
      }
    }

    const chunks = await this.headersToDict(frame.headers, preprocess);

    await self._frame({
      type: 'SYN_STREAM',
      id: frame.id,
      flags: frame.fin ? constants.flags.FLAG_FIN : 0
    }, function (buf) {
      buf.reserve(10)

      buf.writeUInt32BE(frame.id & 0x7fffffff)
      buf.writeUInt32BE((frame.associated ?? 0) & 0x7fffffff)

      var weight = (frame.priority && frame.priority.weight) ||
                  constants.DEFAULT_WEIGHT

      // We only have 3 bits for priority in SPDY, try to fit it into this
      var priority = weightToPriority(weight)
      buf.writeUInt8(priority << 5)

      // CREDENTIALS slot
      buf.writeUInt8(0)

      for (const chunk of chunks) {
        buf.copyFrom(chunk)
      }
    })
  }

  async requestFrame (frame: SpdyRequestOptions) {
    await this._synFrame({
      id: frame.id,
      fin: frame.fin,
      associated: 0,
      method: frame.method,
      version: frame.version,
      scheme: frame.scheme,
      host: frame.host,
      path: frame.path,
      priority: frame.priority,
      headers: frame.headers
    })
  }

  async responseFrame (frame: {
    id: number;
    reason?: string;
    status: keyof typeof constants.statusReason;
    headers: SpdyHeaders;
  }) {
    var self = this

    var reason = frame.reason
    if (!reason) {
      reason = constants.statusReason[frame.status]
    }

    const chunks = await this.headersToDict(frame.headers, headers => {
      if (self.version === 2) {
        headers.status = frame.status + ' ' + reason
        headers.version = 'HTTP/1.1'
      } else {
        headers[':status'] = frame.status + ' ' + reason
        headers[':version'] = 'HTTP/1.1'
      }
    });

    await this._frame({
      type: 'SYN_REPLY',
      id: frame.id,
      flags: 0
    }, function (buf) {
      buf.reserve(self.version === 2 ? 6 : 4)

      buf.writeUInt32BE(frame.id & 0x7fffffff)

      // Unused data
      if (self.version === 2) {
        buf.writeUInt16BE(0)
      }

      for (var i = 0; i < chunks.length; i++) {
        buf.copyFrom(chunks[i])
      }
    })
  }

  async pushFrame (frame: Pick<SpdyRequestOptions, Exclude<keyof SpdyRequestOptions, 'associated'>> & {
    promisedId: number;
    response: SpdyHeaders;
  }) {

    await this._checkPush()

    await this._synFrame({
      id: frame.promisedId,
      associated: frame.id,
      method: frame.method,
      status: frame.status || 200,
      version: frame.version,
      scheme: frame.scheme,
      host: frame.host,
      path: frame.path,
      priority: frame.priority,

      // Merge everything together, there is no difference in SPDY protocol
      headers: Object.assign(Object.assign({}, frame.headers), frame.response)
    })
  }

  async headersFrame (frame: {
    headers: SpdyHeaders;
    id: number;
  }) {
    var self = this

    const chunks = await this.headersToDict(frame.headers, null);

    await self._frame({
      type: 'HEADERS',
      id: frame.id,
      priority: false,
      flags: 0
    }, function (buf) {
      buf.reserve(4 + (self.version === 2 ? 2 : 0))
      buf.writeUInt32BE(frame.id & 0x7fffffff)

      // Unused data
      if (self.version === 2) { buf.writeUInt16BE(0) }

      for (var i = 0; i < chunks.length; i++) {
        buf.copyFrom(chunks[i])
      }
    })
  }

  async dataFrame (frame: {
    id: number;
    fin: boolean;
    data: Uint8Array;
    priority: false | number;
  }) {
    if (!this.version) {
      console.error('hmm 1')
      await new Promise(ok => this.once('version', ok));
      assert(this.version)
    }

    // if (frame.fin) throw new Error(`fin`)

    // debug('id=%d type=DATA', frame.id)

    var buffer = new WriteBuffer()
    buffer.reserve(8 + frame.data.length)

    buffer.writeUInt32BE(frame.id & 0x7fffffff)
    buffer.writeUInt8(frame.fin ? 0x01 : 0x0)
    buffer.writeUInt24BE(frame.data.length)
    buffer.copyFrom(frame.data)

    var chunks = buffer.render()
    await new Promise(ok => {
      var toWrite: WritableData = {
        stream: frame.id,
        priority: frame.priority,
        chunks: chunks,
        callback: ok
      }

      var self = this
      this._resetTimeout()

      var bypass = (this.version ?? 0) < 3.1
      this.window.send.update(-frame.data.length, bypass ? undefined : function () {
        self._resetTimeout()
        self.schedule(toWrite)
      })

      if (bypass) {
        this._resetTimeout()
        this.schedule(toWrite)
      }
    });
  }

  async pingFrame (frame: {
    ack?: boolean; // TODO: this is not transmitted!
    opaque: Uint8Array,
  }) {
    await this._frame({
      type: 'PING',
      id: 0,
      flags: 0
    }, function (buf) {
      buf.reserve(4)

      var opaque = frame.opaque
      buf.copyFrom(opaque, opaque.length - 4)
      // buf.writeUInt32BE(opaque.readUInt32BE(opaque.length - 4, true))
    })
  }

  async rstFrame (frame: {
    id: number;
    code: keyof typeof constants.error;
    extra?: string;
  }) {
    await this._frame({
      type: 'RST_STREAM',
      id: frame.id,
      flags: 0
    }, function (buf) {
      buf.reserve(8)

      // Stream ID
      buf.writeUInt32BE(frame.id & 0x7fffffff)
      // Status Code
      buf.writeUInt32BE(constants.error[frame.code])


      // Extra debugging information
      if (frame.extra) {
        buf.write(frame.extra)
      }
    })
  }

  prefaceFrame () {
  }

  async settingsFrame (options: Partial<Record<SpdySettingsKey,number>>, callback?: ClassicCallback) {
    var self = this

    var key = this.version + '/' + JSON.stringify(options)

    var settings = Framer.settingsCache[key]
    if (settings) {
      // debug('cached settings')
      this._resetTimeout()
      this.schedule({
        stream: 0,
        priority: false,
        chunks: settings,
        callback: callback
      })
      return
    }

    var params: Array<{key: number, value: number}> = []
    for (var i = 0; i < constants.settingsIndex.length; i++) {
      var name = constants.settingsIndex[i]
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

    var frame = await this._frame({
      type: 'SETTINGS',
      id: 0,
      flags: 0
    }, function (buf) {
      buf.reserve(4 + 8 * params.length)

      // Count of entries
      buf.writeUInt32BE(params.length)

      params.forEach(function (param) {
        var flag = constants.settings.FLAG_SETTINGS_PERSIST_VALUE << 24

        if (self.version === 2) {
          buf.writeUInt32LE(flag | param.key)
        } else { buf.writeUInt32BE(flag | param.key) }
        buf.writeUInt32BE(param.value & 0x7fffffff)
      })
    })

    if (frame) {
      Framer.settingsCache[key] = frame
    }
  }

  async ackSettingsFrame () {
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
      buf.reserve(8)

      // ID
      buf.writeUInt32BE(frame.id & 0x7fffffff)

      // Delta
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
      // Status
      buf.writeUInt32BE(constants.goaway[frame.code])
    })
  }

  async priorityFrame (frame: {
    priority: PriorityJson;
  }) {
    // No such thing in SPDY
  }

  async xForwardedFor (frame: {
    host: string;
  }) {
    await this._frame({
      type: 'X_FORWARDED_FOR',
      id: 0,
      flags: 0
    }, function (buf) {
      buf.writeUInt32BE(Buffer.byteLength(frame.host))
      buf.write(frame.host)
    })
  }

  static settingsCache: Record<string, Uint8Array[]> = {};
}
