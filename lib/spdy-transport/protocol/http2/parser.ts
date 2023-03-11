import { Parser as BaseParser } from '../base/parser.ts'
import { addHeaderLine, ProtocolError } from "../base/utils.ts"
import { FrameHeader, FrameUnion, SpdyHeaders, HeadersFrame, PushPromiseFrame } from '../types.ts';
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { OffsetBuffer } from "../../../obuf.ts";
import * as constants from "./constants.ts";
import { Decompressor } from "../../../hpack/decompressor.ts";
import { HpackHeader } from '../../../hpack/types.ts';

type Frames = Array<FrameUnion>;
type SettingsDict = Partial<Record<typeof constants['settingsIndex'][number] & string,number>>;

export class Parser extends BaseParser<FrameUnion> {
  isServer: boolean;
  state:
    | 'preface'
    | 'frame-head'
    | 'frame-body'
    = 'preface';
  pendingHeader: null | FrameHeader;

  _lastHeaderBlock: null | {
    id: number;
    frame: HeadersFrame | PushPromiseFrame,
    queue: Uint8Array[],
    size: number;
  } = null;
  maxFrameSize: number;
  maxHeaderListSize: number;

  constructor (options: ConstructorParameters<typeof BaseParser>[0] & {
    isServer: boolean;
  }) {
    super(options)

    this.isServer = options.isServer
    this.waiting = constants.PREFACE_SIZE
    this.pendingHeader = null

    // Header Block queue
    this._lastHeaderBlock = null
    this.maxFrameSize = constants.INITIAL_MAX_FRAME_SIZE
    this.maxHeaderListSize = constants.DEFAULT_MAX_HEADER_LIST_SIZE
  }

  hpackDecompressor = new Decompressor({
    table: {
      maxSize: constants.HEADER_TABLE_SIZE
    }
  })

  error = (code: keyof typeof constants['errorByCode'], message: string) => {
    // @ts-expect-error TODO: reconsile the codes between h2 and spdy
    return new ProtocolError(constants.errorByCode[code], message);
  }

  setMaxFrameSize (size: number) {
    this.maxFrameSize = size
  }

  setMaxHeaderListSize (size: number) {
    this.maxHeaderListSize = size
  }

  // Only for testing
  skipPreface () {
    // Just some number bigger than 3.1, doesn't really matter for HTTP2
    this.setVersion(4)

    // Parse frame header!
    this.state = 'frame-head'
    this.waiting = constants.FRAME_HEADER_SIZE
  }

  async execute (buffer: OffsetBuffer): Promise<Frames> {
    if (this.state === 'preface') {
      this.onPreface(buffer);
      return [];
    }

    if (this.state === 'frame-head') {
      this.onFrameHead(buffer);
      if (this.waiting > 0) return [];
    }

    assert(this.state === 'frame-body' && this.pendingHeader !== null)

    var self = this
    var header = this.pendingHeader
    this.pendingHeader = null

    const frame = await this.onFrameBody(header, buffer);

    self.state = 'frame-head'
    self.partial = false
    self.waiting = constants.FRAME_HEADER_SIZE
    return frame;
  }

  async executePartial (buffer: OffsetBuffer): Promise<Frames> {
    var header = this.pendingHeader!

    assertEquals(header.flags & constants.flags.PADDED, 0)

    if (this.window) { this.window.recv.update(-buffer.size) }

    return [{
      type: 'DATA',
      id: header.id!,

      // Partial DATA can't be FIN
      fin: false,
      data: buffer.take(buffer.size)
    }]
  }

  onPreface (buffer: OffsetBuffer) {
    if (buffer.take(buffer.size).toString() !== constants.PREFACE) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid preface')
    }

    this.skipPreface()
  }

  onFrameHead (buffer: OffsetBuffer) {
    var header = {
      length: buffer.readUInt24BE(),
      control: true,
      type: buffer.readUInt8(),
      flags: buffer.readUInt8(),
      id: buffer.readUInt32BE() & 0x7fffffff
    }

    if (header.length > this.maxFrameSize) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'Frame length OOB')
    }

    header.control = header.type !== constants.frameType.DATA

    this.state = 'frame-body'
    this.pendingHeader = header
    this.waiting = header.length
    this.partial = !header.control

    // TODO(indutny): eventually support partial padded DATA
    if (this.partial) {
      this.partial = (header.flags & constants.flags.PADDED) === 0
    }
  }

  onFrameBody (header: FrameHeader, buffer: OffsetBuffer): Frames {
    var frameType = constants.frameType

    if (header.type === frameType.DATA) {
      return this.onDataFrame(header, buffer)
    } else if (header.type === frameType.HEADERS) {
      return this.onHeadersFrame(header, buffer)
    } else if (header.type === frameType.CONTINUATION) {
      return this.onContinuationFrame(header, buffer)
    } else if (header.type === frameType.WINDOW_UPDATE) {
      return this.onWindowUpdateFrame(header, buffer)
    } else if (header.type === frameType.RST_STREAM) {
      return this.onRSTFrame(header, buffer)
    } else if (header.type === frameType.SETTINGS) {
      return this.onSettingsFrame(header, buffer)
    } else if (header.type === frameType.PUSH_PROMISE) {
      return this.onPushPromiseFrame(header, buffer)
    } else if (header.type === frameType.PING) {
      return this.onPingFrame(header, buffer)
    } else if (header.type === frameType.GOAWAY) {
      return this.onGoawayFrame(header, buffer)
    } else if (header.type === frameType.PRIORITY) {
      return this.onPriorityFrame(header, buffer)
    } else if (header.type === frameType.X_FORWARDED_FOR) {
      return this.onXForwardedFrame(header, buffer)
    } else {
      return this.onUnknownFrame(header, buffer)
    }
  }

  onUnknownFrame (header: FrameHeader, buffer: OffsetBuffer): Frames {
    if (this._lastHeaderBlock !== null) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Received unknown frame in the middle of a header block')
    }
    throw new Error(`unknown frmae: ${header.type}`)
    // return { type: 'unknown: ' + header.type };
  }

  unpadData (header: FrameHeader, body: OffsetBuffer) {
    var isPadded = (header.flags & constants.flags.PADDED) !== 0

    if (!isPadded) { return body }

    if (!body.has(1)) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'Not enough space for padding')
    }

    var pad = body.readUInt8()
    if (!body.has(pad)) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid padding size')
    }

    var contents = body.clone(body.size - pad)
    body.skip(body.size)
    return contents
  }

  onDataFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    var isEndStream = (header.flags & constants.flags.END_STREAM) !== 0

    if (header.id === 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Received DATA frame with stream=0')
    }

    // Count received bytes
    if (this.window) {
      this.window.recv.update(-body.size)
    }

    const data = this.unpadData(header, body);

    return [{
      type: 'DATA',
      id: header.id!,
      fin: isEndStream,
      data: data.take(data.size)
    }]
  }

  initHeaderBlock (header: FrameHeader, frame: HeadersFrame | PushPromiseFrame, block: OffsetBuffer) {
    if (this._lastHeaderBlock) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Duplicate Stream ID')
    }

    this._lastHeaderBlock = {
      id: header.id!,
      frame: frame,
      queue: [],
      size: 0
    }

    return this.queueHeaderBlock(header, block)
  }

  queueHeaderBlock (header: FrameHeader, block: OffsetBuffer) {
    var self = this
    var item = this._lastHeaderBlock
    assert(item);
    if (!this._lastHeaderBlock || item.id !== header.id) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'No matching stream for continuation')
    }

    var fin = (header.flags & constants.flags.END_HEADERS) !== 0

    var chunks1 = block.toChunks()
    for (var i = 0; i < chunks1.length; i++) {
      var chunk = chunks1[i]
      item.queue.push(chunk)
      item.size += chunk.length
    }

    if (item.size >= self.maxHeaderListSize) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Compressed header list is too large')
    }

    if (!fin) { return []; }
    this._lastHeaderBlock = null

    let chunks: HpackHeader[];
    try {
      chunks = this.hpackDecompressor.transformOne(item.queue);
    } catch (err) {
      throw this.error(constants.error.COMPRESSION_ERROR, err.message);
    }

    var headers: SpdyHeaders = {}
    var size = 0
    for (const header of chunks) {

      size += header.name.length + header.value.length + 32
      if (size >= self.maxHeaderListSize) {
        throw self.error(constants.error.PROTOCOL_ERROR,
          'Header list is too large')
      }

      if (/[A-Z]/.test(header.name)) {
        throw self.error(constants.error.PROTOCOL_ERROR,
          'Header name must be lowercase')
      }

      addHeaderLine(header.name, header.value, headers)
    }

    item.frame.headers = headers
    item.frame.path = headers[':path']

    return [item.frame]
  }

  onHeadersFrame (header: FrameHeader, body: OffsetBuffer) {
    var self = this

    if (header.id === 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for HEADERS')
    }

    const data = this.unpadData(header, body);

    var isPriority = (header.flags & constants.flags.PRIORITY) !== 0
    if (!data.has(isPriority ? 5 : 0)) {
      throw self.error(constants.error.FRAME_SIZE_ERROR,
        'Not enough data for HEADERS')
    }

    var exclusive = false
    var dependency = 0
    var weight = constants.DEFAULT_WEIGHT
    if (isPriority) {
      dependency = data.readUInt32BE()
      exclusive = (dependency & 0x80000000) !== 0
      dependency &= 0x7fffffff

      // Weight's range is [1, 256]
      weight = data.readUInt8() + 1
    }

    if (dependency === header.id) {
      throw self.error(constants.error.PROTOCOL_ERROR,
        'Stream can\'t dependend on itself')
    }

    var streamInfo: HeadersFrame = {
      type: 'HEADERS',
      id: header.id!,
      priority: {
        parent: dependency,
        exclusive: exclusive,
        weight: weight
      },
      fin: (header.flags & constants.flags.END_STREAM) !== 0,
      writable: true,
      headers: null,
      path: null
    }

    return self.initHeaderBlock(header, streamInfo, data)
  }

  onContinuationFrame (header: FrameHeader, body: OffsetBuffer) {
    return this.queueHeaderBlock(header, body)
  }

  onRSTFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    if (body.size !== 4) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'RST_STREAM length not 4')
    }

    if (header.id === 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for RST_STREAM')
    }

    return [{
      type: 'RST',
      id: header.id!,
      code: constants.errorByCode[body.readUInt32BE()]
    }]
  }

  _validateSettings (settings: SettingsDict) {
    if (settings['enable_push'] !== undefined &&
        settings['enable_push'] !== 0 &&
        settings['enable_push'] !== 1) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'SETTINGS_ENABLE_PUSH must be 0 or 1')
    }

    if (settings['initial_window_size'] !== undefined &&
        (settings['initial_window_size'] > constants.MAX_INITIAL_WINDOW_SIZE ||
        settings['initial_window_size'] < 0)) {
      throw this.error(constants.error.FLOW_CONTROL_ERROR,
        'SETTINGS_INITIAL_WINDOW_SIZE is OOB')
    }

    if (settings['max_frame_size'] !== undefined &&
        (settings['max_frame_size'] > constants.ABSOLUTE_MAX_FRAME_SIZE ||
        settings['max_frame_size'] < constants.INITIAL_MAX_FRAME_SIZE)) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'SETTINGS_MAX_FRAME_SIZE is OOB')
    }
  }

  onSettingsFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    if (header.id !== 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for SETTINGS')
    }

    var isAck = (header.flags & constants.flags.ACK) !== 0
    if (isAck && body.size !== 0) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'SETTINGS with ACK and non-zero length')
    }

    if (isAck) {
      return [{ type: 'ACK_SETTINGS' }]
    }

    if (body.size % 6 !== 0) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'SETTINGS length not multiple of 6')
    }

    var settings: SettingsDict = {}
    while (!body.isEmpty()) {
      var id = body.readUInt16BE()
      var value = body.readUInt32BE()
      var name = constants.settingsIndex[id]

      if (name) {
        settings[name] = value
      }
    }

    this._validateSettings(settings)

    return [{
      type: 'SETTINGS',
      settings: settings
    }]
  }

  onPushPromiseFrame (header: FrameHeader, body: OffsetBuffer) {
    if (header.id === 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for PUSH_PROMISE')
    }

    var self = this
    const data = this.unpadData(header, body)

    if (!data.has(4)) {
      throw self.error(constants.error.FRAME_SIZE_ERROR,
        'PUSH_PROMISE length less than 4')
    }

    var streamInfo: PushPromiseFrame = {
      type: 'PUSH_PROMISE',
      id: header.id!,
      fin: false,
      promisedId: data.readUInt32BE() & 0x7fffffff,
      headers: null,
      path: null
    }

    return self.initHeaderBlock(header, streamInfo, data)
  }

  onPingFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    if (body.size !== 8) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'PING length != 8')
    }

    if (header.id !== 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for PING')
    }

    var ack = (header.flags & constants.flags.ACK) !== 0
    return [{ type: 'PING', opaque: body.take(body.size), ack: ack }];
  }

  onGoawayFrame (header: FrameHeader, body: OffsetBuffer) {
    if (!body.has(8)) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'GOAWAY length < 8')
    }

    if (header.id !== 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for GOAWAY')
    }

    var frame: FrameUnion = {
      type: 'GOAWAY',
      lastId: body.readUInt32BE(),
      code: constants.goawayByCode[body.readUInt32BE()]
    }

    if (body.size !== 0) { frame.debug = body.take(body.size) }

    return [frame];
  }

  onPriorityFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    if (body.size !== 5) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'PRIORITY length != 5')
    }

    if (header.id === 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Invalid stream id for PRIORITY')
    }

    var dependency = body.readUInt32BE()

    // Again the range is from 1 to 256
    var weight = body.readUInt8() + 1

    if (dependency === header.id) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'Stream can\'t dependend on itself')
    }

    return [{
      type: 'PRIORITY',
      id: header.id!,
      priority: {
        exclusive: (dependency & 0x80000000) !== 0,
        parent: dependency & 0x7fffffff,
        weight: weight
      }
    }]
  }

  onWindowUpdateFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    if (body.size !== 4) {
      throw this.error(constants.error.FRAME_SIZE_ERROR,
        'WINDOW_UPDATE length != 4')
    }

    var delta = body.readInt32BE()
    if (delta === 0) {
      throw this.error(constants.error.PROTOCOL_ERROR,
        'WINDOW_UPDATE delta == 0')
    }

    return [{
      type: 'WINDOW_UPDATE',
      id: header.id!,
      delta: delta
    }]
  }

  onXForwardedFrame (header: FrameHeader, body: OffsetBuffer): Frames {
    return [{
      type: 'X_FORWARDED_FOR',
      host: body.take(body.size).toString()
    }]
  }
}
