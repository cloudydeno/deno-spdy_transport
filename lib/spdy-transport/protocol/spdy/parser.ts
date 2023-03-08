import { FRAME_HEADER_SIZE, flags as flagConstants, error, DEFAULT_WEIGHT, errorByCode, goawayByCode } from './constants.ts';

import { Parser as BaseParser } from '../base/parser.ts'
import { addHeaderLine, priorityToWeight, ProtocolError, weightToPriority } from "../base/utils.ts"
import { ClassicCallback, DataFrame, FrameCallback, FrameHeader, FrameUnion, RstFrame, SettingsKey, SpdyHeaders } from '../types.ts';
import { assert } from "https://deno.land/std@0.170.0/testing/asserts.ts";
import { OffsetBuffer } from "../../../obuf.ts";

type Frames = null | FrameUnion | Array<FrameUnion>;

export class Parser extends BaseParser<FrameUnion> {
  isServer: boolean;
  state:
    | 'frame-head'
    | 'frame-body'
  ;
  pendingHeader: null | FrameHeader;

  constructor (options: ConstructorParameters<typeof BaseParser>[0] & {
    isServer: boolean;
  }) {
    super(options)

    this.isServer = options.isServer
    this.waiting = FRAME_HEADER_SIZE
    this.state = 'frame-head'
    this.pendingHeader = null
  }

  static create (options: ConstructorParameters<typeof Parser>[0]) {
    return new Parser(options)
  }

  setMaxFrameSize (size: number) {
    // http2-only
  }

  setMaxHeaderListSize (size: number) {
    // http2-only
  }

  // Only for testing
  skipPreface () {
  }

  async execute (buffer: OffsetBuffer) {
    if (this.state === 'frame-head') {
      await this.onFrameHead(buffer);
      return null;
    }

    assert(this.state === 'frame-body' && this.pendingHeader !== null)

    var header = this.pendingHeader
    this.pendingHeader = null

    const frame = await this.onFrameBody(header, buffer);
    // console.error('onFrameBody', {header, frame})

    this.state = 'frame-head'
    this.waiting = FRAME_HEADER_SIZE
    this.partial = false
    return frame;
  }

  async executePartial (buffer: OffsetBuffer): Promise<Frames> {
    var header = this.pendingHeader

    if (this.window) {
      this.window.recv.update(-buffer.size)
    }

    // DATA frame
    return {
      type: 'DATA',
      id: header!.id!,

      // Partial DATA can't be FIN
      fin: false,
      data: buffer.take(buffer.size)
    };
  }

  async onFrameHead (buffer: OffsetBuffer) {
    var header: FrameHeader = {
      control: (buffer.peekUInt8() & 0x80) === 0x80,
      flags: -1,
      length: -1,
    }

    if (header.control) {
      header.version = buffer.readUInt16BE() & 0x7fff
      header.type = buffer.readUInt16BE()
    } else {
      header.id = buffer.readUInt32BE() & 0x7fffffff
    }
    header.flags = buffer.readUInt8()
    header.length = buffer.readUInt24BE()

    if (this.version === null && header.control) {
      // TODO(indutny): do ProtocolError here and in the rest of errors
      if (header.version !== 2 && header.version !== 3) {
        throw new Error(`Unsupported SPDY version: ${header.version}`);
      }
      this.setVersion(header.version)
    }

    this.state = 'frame-body'
    this.waiting = header.length
    this.pendingHeader = header
    this.partial = !header.control
  }

  async onFrameBody (header: FrameHeader, buffer: OffsetBuffer): Promise<Frames> {
    // Data frame
    if (!header.control) {
      // Count received bytes
      if (this.window) {
        this.window.recv.update(-buffer.size)
      }

      // No support for compressed DATA
      if ((header.flags & flagConstants.FLAG_COMPRESSED) !== 0) {
        throw new Error('DATA compression not supported');
      }

      if (header.id === 0) {
        throw this.error("PROTOCOL_ERROR",
          'Invalid stream id for DATA');
      }

      return {
        type: 'DATA',
        id: header.id!,
        fin: (header.flags & flagConstants.FLAG_FIN) !== 0,
        data: buffer.take(buffer.size)
      };
    }

    if (header.type === 0x01 || header.type === 0x02) { // SYN_STREAM or SYN_REPLY
      return await this.onSynHeadFrame(header.type, header.flags, buffer)
    } else if (header.type === 0x03) { // RST_STREAM
      return this.onRSTFrame(buffer)
    } else if (header.type === 0x04) { // SETTINGS
      return this.onSettingsFrame(buffer)
    } else if (header.type === 0x05) {
      return { type: 'NOOP' };
    } else if (header.type === 0x06) { // PING
      return this.onPingFrame(buffer)
    } else if (header.type === 0x07) { // GOAWAY
      return this.onGoawayFrame(buffer)
    } else if (header.type === 0x08) { // HEADERS
      return await this.onHeaderFrames(buffer)
    } else if (header.type === 0x09) { // WINDOW_UPDATE
      return this.onWindowUpdateFrame(buffer)
    } else if (header.type === 0xf000) { // X-FORWARDED
      return this.onXForwardedFrame(buffer)
    } else {
      console.warn(`Parsed unknown SPDY frame: ${header.type}`)
      // return { type: 'unknown: ' + header.type })
      return [];
    }
  }

  _filterHeader (headers: SpdyHeaders, name: string) {
    var res: SpdyHeaders = {}
    var keys = Object.keys(headers)

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      if (key !== name) {
        res[key] = headers[key]
      }
    }

    return res
  }

  async onSynHeadFrame (type: number,
    flags: number,
    body: OffsetBuffer): Promise<Frames> {
    var self = this
    var stream = type === 0x01
    var offset = stream ? 10 : this.version === 2 ? 6 : 4

    if (!body.has(offset)) {
      throw new Error('SynHead OOB')
    }

    var head = body.clone(offset)
    body.skip(offset)
    const headers = await this.parseKVs(body);

    if (stream &&
        (!headers[':method'] || !headers[':path'])) {
      throw new Error('Missing `:method` and/or `:path` header')
    }

    var id = head.readUInt32BE() & 0x7fffffff

    if (id === 0) {
      throw self.error("PROTOCOL_ERROR",
        'Invalid stream id for HEADERS')
    }

    var associated = stream ? head.readUInt32BE() & 0x7fffffff : 0
    var priority = stream
      ? head.readUInt8() >> 5
      : weightToPriority(DEFAULT_WEIGHT)
    var fin = (flags & flagConstants.FLAG_FIN) !== 0
    var unidir = (flags & flagConstants.FLAG_UNIDIRECTIONAL) !== 0
    var path = headers[':path']

    var isPush = stream && associated !== 0

    var weight = priorityToWeight(priority)
    var priorityInfo = {
      weight: weight,
      exclusive: false,
      parent: 0
    }

    if (!isPush) {
      return {
        type: 'HEADERS',
        id: id,
        priority: priorityInfo,
        fin: fin,
        writable: !unidir,
        headers: headers,
        path: path
      };
    }

    if (stream && !headers[':status']) {
      throw new Error('Missing `:status` header')
    }

    var filteredHeaders = self._filterHeader(headers, ':status')

    return [ {
      type: 'PUSH_PROMISE',
      id: associated,
      fin: false,
      promisedId: id,
      headers: filteredHeaders,
      path: path
    }, {
      type: 'HEADERS',
      id: id,
      fin: fin,
      priority: priorityInfo,
      writable: true,
      path: undefined,
      headers: {
        ':status': headers[':status']
      }
    }];
  }

  async onHeaderFrames (body: OffsetBuffer): Promise<Frames> {
    var offset = this.version === 2 ? 6 : 4
    if (!body.has(offset)) {
      throw new Error('HEADERS OOB')
    }

    var streamId = body.readUInt32BE() & 0x7fffffff
    if (this.version === 2) { body.skip(2) }

    const headers = await this.parseKVs(body);

    return {
      type: 'HEADERS',
      priority: {
        parent: 0,
        exclusive: false,
        weight: DEFAULT_WEIGHT
      },
      id: streamId,
      fin: false,
      writable: true,
      path: undefined,
      headers: headers
    }
  }

  async parseKVs (buffer: OffsetBuffer) {
    const chunks = await new Promise<Uint8Array[]>((ok, fail) => {
      this.decompress!.write(buffer.toChunks(), (err, chunks) => {
        if (err) { fail(err); } else { ok(chunks!); }
      });
    });

    var buffer = new OffsetBuffer()
    for (var i = 0; i < chunks.length; i++) {
      buffer.push(chunks[i])
    }

    var size = this.version === 2 ? 2 : 4
    if (!buffer.has(size)) { throw new Error('KV OOB') }

    var count = this.version === 2
      ? buffer.readUInt16BE()
      : buffer.readUInt32BE()

    var headers: SpdyHeaders = {}

    const readString = () => {
      if (!buffer.has(size)) { return null }
      var len = this.version === 2
        ? buffer.readUInt16BE()
        : buffer.readUInt32BE()

      if (!buffer.has(len)) { return null }

      var value = buffer.take(len)
      return value.toString()
    }

    while (count > 0) {
      var key = readString()
      var value = readString()

      if (key === null || value === null) {
        throw new ProtocolError('INTERNAL_ERROR', 'Headers OOB')
      }

      if (this.version! < 3) {
        var isInternal = /^(method|version|url|host|scheme|status)$/.test(key)
        if (key === 'url') {
          key = 'path'
        }
        if (isInternal) {
          key = ':' + key
        }
      }

      // Compatibility with HTTP2
      if (key === ':status') {
        value = value.split(/ /g, 2)[0]
      }

      count--
      if (key === ':host') {
        key = ':authority'
      }

      // Skip version, not present in HTTP2
      if (key === ':version') {
        continue
      }

      for (const valueItem of value.split(/\0/g)) {
        addHeaderLine(key, valueItem, headers)
      }
    }

    return headers;
  }

  onRSTFrame (body: OffsetBuffer): Frames {
    if (!body.has(8)) { throw new Error('RST OOB') }

    var frame: RstFrame = {
      type: 'RST',
      id: body.readUInt32BE() & 0x7fffffff,
      code: errorByCode[body.readUInt32BE()]
    }

    if (frame.id === 0) {
      throw this.error("PROTOCOL_ERROR",
        'Invalid stream id for RST');
    }

    if (body.size !== 0) {
      frame.extra = body.take(body.size)
    }
    return frame;
  }

  onSettingsFrame (body: OffsetBuffer): Frames {
    if (!body.has(4)) {
      throw new Error('SETTINGS OOB')
    }

    var settings: Partial<Record<SettingsKey,number>> = {}
    var number = body.readUInt32BE()
    var idMap: Record<string,SettingsKey> = {
      1: 'upload_bandwidth',
      2: 'download_bandwidth',
      3: 'round_trip_time',
      4: 'max_concurrent_streams',
      5: 'current_cwnd',
      6: 'download_retrans_rate',
      7: 'initial_window_size',
      8: 'client_certificate_vector_size'
    }

    if (!body.has(number * 8)) {
      throw new Error('SETTINGS OOB#2')
    }

    for (var i = 0; i < number; i++) {
      var id = this.version === 2
        ? body.readUInt32LE()
        : body.readUInt32BE()

      var flags = (id >> 24) & 0xff
      id = id & 0xffffff

      // Skip persisted settings
      if (flags & 0x2) { continue }

      var name = idMap[id]

      settings[name] = body.readUInt32BE()
    }

    return  {
      type: 'SETTINGS',
      settings: settings
    }
  }

  onPingFrame (body: OffsetBuffer): Frames {
    if (!body.has(4)) {
      throw new Error('PING OOB')
    }

    var isServer = this.isServer
    var opaque = body.clone(body.size).take(body.size)
    var id = body.readUInt32BE()
    var ack = isServer ? (id % 2 === 0) : (id % 2 === 1)

    return { type: 'PING', opaque: opaque, ack: ack }
  }

  onGoawayFrame (body: OffsetBuffer): Frames {
    if (!body.has(8)) {
      throw new Error('GOAWAY OOB')
    }

    return {
      type: 'GOAWAY',
      lastId: body.readUInt32BE() & 0x7fffffff,
      code: goawayByCode[body.readUInt32BE()]
    }
  }

  onWindowUpdateFrame (body: OffsetBuffer): Frames {
    if (!body.has(8)) {
      throw new Error('WINDOW_UPDATE OOB')
    }

    return {
      type: 'WINDOW_UPDATE',
      id: body.readUInt32BE() & 0x7fffffff,
      delta: body.readInt32BE()
    }
  }

  onXForwardedFrame (body: OffsetBuffer): Frames {
    if (!body.has(4)) {
      throw new Error('X_FORWARDED OOB')
    }

    var len = body.readUInt32BE()
    if (!body.has(len)) { throw new Error('X_FORWARDED host length OOB') }

    return {
      type: 'X_FORWARDED_FOR',
      host: body.take(len).toString()
    }
  }
}
