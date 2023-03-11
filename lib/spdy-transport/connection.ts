// var debug = {
//   server: require('debug')('spdy:connection:server'),
//   client: require('debug')('spdy:connection:client')
// }
import { EventEmitter } from 'node:events';
export { protocol } from './protocol/index.ts'
import { bytesAsHex, Timeout } from './utils.ts'
import { PriorityJson, PriorityTree } from "./priority.ts"
import { Window } from "./window.ts"
import { Stream } from "./stream.ts"
import { protocol } from "./protocol/index.ts";
import { MAX_PRIORITY_STREAMS, DEFAULT_MAX_CHUNK } from "./protocol/base/constants.ts"
import { ProtocolError } from "./protocol/base/utils.ts";
import * as spdyProtocol from "./protocol/spdy/index.ts";
import * as http2Protocol from "./protocol/http2/index.ts";
import { Parser } from "./protocol/spdy/parser.ts";
import { Framer } from "./protocol/spdy/framer.ts";
import { CompressionPair } from "./protocol/spdy/zlib-pool.ts";
import { ClassicCallback, FrameUnion, GoawayFrame, HeadersFrame, PingFrame, SpdySettingsKey, SpdyHeaders } from './protocol/types.ts';
import { forEach } from "https://deno.land/x/stream_observables@v1.3/transforms/for-each.ts";
import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";

export type StreamSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type ConnectionOptions = {
  protocol: 'spdy' | 'http2';
  isServer: boolean;
  maxStreams?: number;
  autoSpdy31?: boolean;
  acceptPush?: boolean;
  maxChunk?: false | number;
  windowSize?: number;
  headerCompression?: boolean;
};

export type CreateStreamOptions = {
  id?: number
  request?: boolean,
  method?: string,
  path?: string,
  host?: string,
  priority?: PriorityJson;
  // priority: {
  //   parent: number;
  //   weight: number;
  //   exclusive?: boolean;
  // },
  headers: SpdyHeaders
  writable?: boolean;
  readable?: boolean;
  parent?: Stream;
  push?: boolean;
};

export type CreatePushOptions = CreateStreamOptions & {
  status: number;
  response: SpdyHeaders;
};

export class Connection extends EventEmitter {
  httpAllowHalfOpen: boolean;

  public _spdyState: {
    timeout: Timeout;
    protocol: typeof spdyProtocol | typeof http2Protocol;
    version: null | 2 | 3 | 3.1;
    constants: typeof spdyProtocol.constants | typeof http2Protocol.constants;
    pair: null | CompressionPair;
    isServer: boolean;
    priorityRoot: PriorityTree;
    maxStreams: number;
    autoSpdy31: boolean;
    acceptPush: boolean; maxChunk: number;
    window: Window;
    streamWindow: Window;
    pool: spdyProtocol.compressionPool | null;
    counters: {
      push: number;
      stream: number;
    },
    stream: {
      map: Record<string,Stream>;
      count: number;
      nextId: number;
      lastId: {
        both: number;
        received: number;
      };
    };
    ping: {
      nextId: number;
      map: Record<string, { cb: ClassicCallback }>;
    };
    goaway: false | number;
    xForward: null | string;
    parser: spdyProtocol.parser | http2Protocol.parser;
    framer: spdyProtocol.framer | http2Protocol.framer;
    alive: boolean;
  };
  socket: StreamSocket;

  constructor (socket: StreamSocket, options: ConnectionOptions) {
    super()

    // NOTE: There's a big trick here. Connection is used as a `this` argument
    // to the wrapped `connection` event listener.
    // socket end doesn't necessarly mean connection drop
    this.httpAllowHalfOpen = true

    const myProtocol = protocol[options.protocol];

    const windowSize = options.windowSize || 1 << 20

    const timeout = new Timeout(this);

    // Connection-level flow control
    const window = new Window({
      id: 0,
      isServer: options.isServer,
      recv: {
        size: myProtocol.constants.DEFAULT_WINDOW,
        max: myProtocol.constants.MAX_INITIAL_WINDOW_SIZE
      },
      send: {
        size: myProtocol.constants.DEFAULT_WINDOW,
        max: myProtocol.constants.MAX_INITIAL_WINDOW_SIZE
      }
    });

    this._spdyState = {
      timeout,

      // Protocol info
      protocol: myProtocol,
      version: null,
      constants: myProtocol.constants,
      pair: null,
      isServer: options.isServer,

      // Root of priority tree (i.e. stream id = 0)
      priorityRoot: new PriorityTree({
        defaultWeight: myProtocol.constants.DEFAULT_WEIGHT,
        maxCount: MAX_PRIORITY_STREAMS
      }),

      // Defaults
      maxStreams: options.maxStreams ||
        myProtocol.constants.MAX_CONCURRENT_STREAMS,

      autoSpdy31: !!options.autoSpdy31,
      // autoSpdy31: myProtocol.name !== 'h2' && options.autoSpdy31,
      acceptPush: options.acceptPush === undefined
        ? !options.isServer
        : options.acceptPush,

      maxChunk: options.maxChunk === false
        ? Infinity
        : options.maxChunk === undefined
          ? DEFAULT_MAX_CHUNK
          : options.maxChunk,

      // Connection-level flow control
      window,

      // Boilerplate for Stream constructor
      streamWindow: new Window({
        id: -1,
        isServer: options.isServer,
        recv: {
          size: windowSize,
          max: myProtocol.constants.MAX_INITIAL_WINDOW_SIZE
        },
        send: {
          size: myProtocol.constants.DEFAULT_WINDOW,
          max: myProtocol.constants.MAX_INITIAL_WINDOW_SIZE
        }
      }),

      // Various state info
      pool: myProtocol.compressionPool ? new myProtocol.compressionPool(options.headerCompression ?? false) : null,
      counters: {
        push: 0,
        stream: 0
      },

      // Init streams list
      stream: {
        map: {},
        count: 0,
        nextId: options.isServer ? 2 : 1,
        lastId: {
          both: 0,
          received: 0
        }
      },
      ping: {
        nextId: options.isServer ? 2 : 1,
        map: {}
      },
      goaway: false,

      // Debug
      // debug: options.isServer ? debug.server : debug.client

      // X-Forwarded feature
      xForward: null,

      // Create parser and hole for framer
      parser: new myProtocol.parser({
        // NOTE: needed to distinguish ping from ping ACK in SPDY
        isServer: options.isServer,
        window: window
      }),
      framer: new myProtocol.framer({
        window: window,
        timeout: timeout
      }),

      alive: true,
    };

    // It starts with DEFAULT_WINDOW, update must be sent to change it on client
    this._spdyState.window.recv.setMax(windowSize)

    // SPDY has PUSH enabled on servers
    if (myProtocol.name === 'spdy') {
      this._spdyState.framer.enablePush(options.isServer)
    }

    if (!options.isServer) { this._spdyState.parser.skipPreface() }

    this.socket = socket

    this._init()
  }

  static create (socket: StreamSocket, options: ConnectionOptions) {
    return new Connection(socket, options)
  }

  _init () {
    var self = this
    var state = this._spdyState
    var pool = state.pool

    // Initialize session window
    state.window.recv.on('drain', function () {
      self._onSessionWindowDrain()
    })

    // Initialize parser
    // state.parser.on('data', function (frame) {
    //   self._handleFrame(frame)
    // })
    state.parser.once('version', function (version) {
      self._onVersion(version)
    })

    // Propagate parser errors
    state.parser.on('error', function (err) {
      self._onParserError(err)
    })

    // Propagate framer errors
    state.framer.on('error', function (err) {
      self.emit('error', err)
    })

    // Hook up the streams
    // TODO: I suppose Framer/Parser could be joined into a TransformStream?
    const printPackets = Deno.args.includes('--print-packets');
    this.socket.readable
      .pipeThrough(forEach(buf => printPackets ? console.log(`I ${new Date().toISOString()}\n000000 ${bytesAsHex(buf)}`) : null))
      .pipeThrough(state.parser.transformStream)
      .pipeTo(new WritableStream({
        write: this._handleFrame.bind(this),
        close: this._handleClose.bind(this),
        abort: this._handleClose.bind(this),
      }));
    state.framer.readable
      .pipeThrough(forEach(buf => printPackets ? console.log(`O ${new Date().toISOString()}\n000000 ${bytesAsHex(buf)}`) : null))
      .pipeTo(this.socket.writable)

    // Allow high-level api to catch socket errors
    // this.socket.on('error', function onSocketError (e) {
    //   self.emit('error', e)
    // })

    // Reset timeout on close
    this.once('close', function () {
      self.setTimeout(0)
    })

    function _onWindowOverflow () {
      self._onWindowOverflow()
    }

    state.window.recv.on('overflow', _onWindowOverflow)
    state.window.send.on('overflow', _onWindowOverflow)

    // Do not allow half-open connections
    // this.socket.allowHalfOpen = false
  }

  _handleClose(reason?: string) {
    console.error('_handleClose', {reason})

    var err: Error & {code?: string} | null = null;
    if (reason) {
      err = new Error('socket hang up: '+reason)
      err.code = 'ECONNRESET'
    }

    this._spdyState.alive = false;
    this.destroyStreams(err)
    this.emit('close')

    if (this._spdyState.pair) {
      this._spdyState.pool?.put(this._spdyState.pair)
    }

    // this._spdyState.framer.resume()
  }

  _onVersion (version: 2 | 3 | 3.1) {
    var state = this._spdyState
    var prev = state.version
    var parser = state.parser
    var framer = state.framer
    var pool = state.pool

    state.version = version
    // state.debug('id=0 version=%d', version)

    // Ignore transition to 3.1
    if (!prev && pool) {
      state.pair = pool.get(version)
      parser.setCompression(state.pair)
      framer.setCompression(state.pair)
    }
    framer.setVersion(version)

    if (!state.isServer) {
      framer.prefaceFrame()
      if (state.xForward !== null) {
        framer.xForwardedFor({ host: state.xForward })
      }
    }

    // Send preface+settings frame (once)
    framer.settingsFrame({
      max_header_list_size: state.constants.DEFAULT_MAX_HEADER_LIST_SIZE,
      max_concurrent_streams: state.maxStreams,
      enable_push: state.acceptPush ? 1 : 0,
      initial_window_size: state.window.recv.max
    })

    // Update session window
    if (state.version >= 3.1 || (state.isServer && state.autoSpdy31)) { this._onSessionWindowDrain() }

    this.emit('version', version)
  }

  _onParserError (err: Error) {
    var state = this._spdyState

    // Prevent further errors
    state.parser.kill()

    // Send GOAWAY
    if (err instanceof ProtocolError) {
      this._goaway({
        lastId: state.stream.lastId.both,
        code: err.code,
        extra: err.message,
        send: true
      })
    }

    this.emit('error', err)
  }

  async _handleFrame (frame: FrameUnion) {
    var state = this._spdyState

    // state.debug('id=0 frame', frame)
    state.timeout.reset()

    // For testing purposes
    // this.emit('frame', frame)

    // Session window update
    if (frame.type === 'WINDOW_UPDATE' && frame.id === 0) {
      if ((state.version ?? 0) < 3.1 && state.autoSpdy31) {
        // state.debug('id=0 switch version to 3.1')
        state.version = 3.1
        this.emit('version', 3.1)
      }
      state.window.send.update(frame.delta)
      return
    }

    if (state.isServer && frame.type === 'PUSH_PROMISE') {
      // state.debug('id=0 server PUSH_PROMISE')
      this._goaway({
        lastId: state.stream.lastId.both,
        code: 'PROTOCOL_ERROR',
        send: true
      })
      return
    }

    var stream: Stream | null = null;

    if (!stream && frame.id !== undefined) {
      // Load created one
      stream = state.stream.map[frame.id]

      // Fail if not found
      if (!stream &&
          frame.type !== 'HEADERS' &&
          frame.type !== 'PRIORITY' &&
          frame.type !== 'RST') {
        // Other side should destroy the stream upon receiving GOAWAY
        if (this._isGoaway(frame.id)) { return }

        // state.debug('id=0 stream=%d not found', frame.id)
        await state.framer.rstFrame({ id: frame.id, code: 'INVALID_STREAM' })
        return
      }
    }

    // Create new stream
    if (!stream && frame.type === 'HEADERS') {
      this._handleHeaders(frame)
      return
    }

    if (stream) {
      await stream._handleFrame(frame)
    } else if (frame.type === 'SETTINGS') {
      this._handleSettings(frame.settings)
    } else if (frame.type === 'ACK_SETTINGS') {
      // TODO(indutny): handle it one day
    } else if (frame.type === 'PING') {
      this._handlePing(frame)
    } else if (frame.type === 'GOAWAY') {
      this._handleGoaway(frame)
    } else if (frame.type === 'X_FORWARDED_FOR') {
      // Set X-Forwarded-For only once
      if (state.xForward === null) {
        state.xForward = frame.host
      }
    } else if (frame.type === 'PRIORITY') {
      // TODO(indutny): handle this
    } else {
      throw new Error(`TODO: unimpl frame type ${frame.type}`);
      // state.debug('id=0 unknown frame type: %s', frame.type)
    }
  }

  _onWindowOverflow () {
    var state = this._spdyState
    // state.debug('id=0 window overflow')
    this._goaway({
      lastId: state.stream.lastId.both,
      code: 'FLOW_CONTROL_ERROR',
      send: true
    })
  }

  _isGoaway (id: number) {
    var state = this._spdyState
    if (state.goaway !== false && state.goaway < id) { return true }
    return false
  }

  _getId () {
    var state = this._spdyState

    var id = state.stream.nextId
    state.stream.nextId += 2
    return id
  }

  _createStream (uri: CreateStreamOptions) {
    var state = this._spdyState
    var id = uri.id
    if (id === undefined) { id = this._getId() }

    var isGoaway = this._isGoaway(id)

    if (uri.push && !state.acceptPush) {
      // state.debug('id=0 push disabled promisedId=%d', id)

      // Fatal error
      this._goaway({
        lastId: state.stream.lastId.both,
        code: 'PROTOCOL_ERROR',
        send: true
      })
      isGoaway = true
    }

    var stream = new Stream(this, {
      id: id,
      request: uri.request !== false,
      method: uri.method,
      path: uri.path,
      host: uri.host,
      priority: uri.priority,
      headers: uri.headers,
      parent: uri.parent,
      readable: !isGoaway && !!uri.readable,
      writable: !isGoaway && !!uri.writable
    })
    var self = this

    // Just an empty stream for API consistency
    if (isGoaway) {
      return stream
    }

    state.stream.lastId.both = Math.max(state.stream.lastId.both, id)

    // state.debug('id=0 add stream=%d', stream.id)
    state.stream.map[stream.id] = stream
    state.stream.count++
    state.counters.stream++
    if (stream.parent !== null) {
      state.counters.push++
    }

    stream.once('close', function () {
      self._removeStream(stream)
    })

    return stream
  }

  _handleHeaders (frame: HeadersFrame) {
    var state = this._spdyState

    // Must be HEADERS frame after stream close
    if (frame.id <= state.stream.lastId.received) { return }

    // Someone is using our ids!
    if ((frame.id + state.stream.nextId) % 2 === 0) {
      state.framer.rstFrame({ id: frame.id, code: 'PROTOCOL_ERROR' })
      return
    }

    assert(frame.headers);
    var stream = this._createStream({
      id: frame.id,
      request: false,
      method: frame.headers[':method'],
      path: frame.headers[':path'],
      host: frame.headers[':authority'],
      priority: frame.priority,
      headers: frame.headers,
      writable: frame.writable
    })

    // GOAWAY
    if (this._isGoaway(stream.id)) {
      return
    }

    state.stream.lastId.received = Math.max(
      state.stream.lastId.received,
      stream.id
    )

    // TODO(indutny) handle stream limit
    if (!this.emit('stream', stream)) {
      // No listeners was set - abort the stream
      stream.abort()
      return
    }

    // Create fake frame to simulate end of the data
    if (frame.fin) {
      stream._handleFrame({ type: 'FIN', fin: true })
    }

    return stream
  }

  _onSessionWindowDrain () {
    var state = this._spdyState
    if ((state.version ?? 0) < 3.1 && !(state.isServer && state.autoSpdy31)) {
      return
    }

    var delta = state.window.recv.getDelta()
    if (delta === 0) {
      return
    }

    // state.debug('id=0 session window drain, update by %d', delta)

    state.framer.windowUpdateFrame({
      id: 0,
      delta: delta
    })
    state.window.recv.update(delta)
  }

  start (version: 2 | 3 | 3.1) {
    this._spdyState.parser.setVersion(version)
  }

  // Mostly for testing
  getVersion () {
    return this._spdyState.version
  }

  _handleSettings (settings: Record<string,number|undefined>) {
    var state = this._spdyState

    state.framer.ackSettingsFrame()

    this._setDefaultWindow(settings)
    if (settings.max_frame_size) { state.framer.setMaxFrameSize(settings.max_frame_size) }

    // TODO(indutny): handle max_header_list_size
    if (settings.header_table_size) {
      try {
        const h2framer = state.framer as http2Protocol.framer;
        h2framer.hpackCompressor?.updateTableSize(settings.header_table_size)
      } catch (e) {
        this._goaway({
          lastId: 0,
          code: 'PROTOCOL_ERROR',
          send: true
        })
        return
      }
    }

    // HTTP2 clients needs to enable PUSH streams explicitly
    if (state.protocol.name !== 'spdy') {
      if (settings.enable_push === undefined) {
        state.framer.enablePush(state.isServer)
      } else {
        state.framer.enablePush(settings.enable_push === 1)
      }
    }

    // TODO(indutny): handle max_concurrent_streams
  }

  _setDefaultWindow (settings: {
    initial_window_size?: number;
  }) {
    if (settings.initial_window_size === undefined) {
      return
    }

    var state = this._spdyState

    // Update defaults
    var window = state.streamWindow
    window.send.setMax(settings.initial_window_size)

    // Update existing streams
    Object.keys(state.stream.map).forEach(function (id) {
      var stream = state.stream.map[id]
      var window = stream._spdyState.window

      window.send.updateMax(settings.initial_window_size!)
    })
  }

  _handlePing (frame: PingFrame) {
    var self = this
    var state = this._spdyState

    // Handle incoming PING
    if (!frame.ack) {
      state.framer.pingFrame({
        opaque: frame.opaque,
        ack: true
      })

      self.emit('ping', frame.opaque)
      return
    }

    // Handle reply PING
    var hex = bytesAsHex(frame.opaque)
    if (!state.ping.map[hex]) {
      return
    }
    var ping = state.ping.map[hex]
    delete state.ping.map[hex]

    if (ping.cb) {
      ping.cb(null)
    }
  }

  _handleGoaway (frame: GoawayFrame) {
    this._goaway({
      lastId: frame.lastId,
      code: frame.code,
      send: false
    })
  }

  ping (callback: ClassicCallback) {
    var state = this._spdyState

    // HTTP2 is using 8-byte opaque
    var opaque = new Uint8Array(state.constants.PING_OPAQUE_SIZE)
    opaque.fill(0)
    new DataView(opaque).setUint32(opaque.length - 4, state.ping.nextId, false)
    state.ping.nextId += 2

    state.ping.map[bytesAsHex(opaque)] = { cb: callback }
    state.framer.pingFrame({
      opaque: opaque,
      ack: false
    })
  }

  getCounter (name: 'push' | 'stream') {
    return this._spdyState.counters[name]
  }

  reserveStream (uri: CreateStreamOptions) {
    var stream = this._createStream(uri)

    // GOAWAY
    if (this._isGoaway(stream.id)) {
      throw new Error('Can\'t send request after GOAWAY');
    }

    return stream
  }

  async request (uri: CreateStreamOptions) {
    var stream = this.reserveStream(uri);

    if (!stream._wasSent()) {
      await stream.send();
    }

    return stream
  }

  _removeStream (stream: Stream) {
    var state = this._spdyState

    // state.debug('id=0 remove stream=%d', stream.id)
    delete state.stream.map[stream.id]
    state.stream.count--

    // if (state.stream.count === 0) {
    //   this.emit('_streamDrain')
    // }
  }

  async _goaway (params: {
    lastId: number;
    code: keyof typeof spdyProtocol.constants.goaway | keyof typeof http2Protocol.constants.goaway;
    send?: boolean;
    extra?: string;
  }) {
    var state = this._spdyState
    var self = this

    state.goaway = params.lastId
    // state.debug('id=0 goaway from=%d', state.goaway)

    Object.keys(state.stream.map).forEach(function (id) {
      var stream = state.stream.map[id]

      // Abort every stream started after GOAWAY
      if (stream.id <= params.lastId) {
        return
      }

      stream.abort()
      stream.emit('error', new Error('New stream after GOAWAY'))
    })

    if (params.send) {
      // Make sure that GOAWAY frame is sent before dumping framer
      await state.framer.goawayFrame({
        lastId: params.lastId,
        code: params.code,
        extra: params.extra
      })
    }

    // Destroy socket if there are no streams
    if (state.stream.count === 0 || params.code !== 'OK') {
      // No further frames should be processed
      state.parser.kill()

      self._onStreamDrain(new Error('Fatal error: ' + params.code))
      return
    }

    // self.on('_streamDrain', self._onStreamDrain)
  }

  _onStreamDrain (error?: Error | null) {
  //   var state = this._spdyState

    // state.debug('id=0 _onStreamDrain')

    // state.framer.dump()
    // state.framer.unpipe(this.socket)
    // state.framer.resume()

    // if (this.socket.destroySoon) {
    //   this.socket.destroySoon()
    // }
    this.emit('close', error)
  }

  async end (callback?: ClassicCallback) {
    var state = this._spdyState

    if (callback) {
      this.once('close', callback)
    }
    await this._goaway({
      lastId: state.stream.lastId.both,
      code: 'OK',
      send: true
    })

    this._spdyState.framer.closeStream?.();
  }

  destroyStreams (err?: Error | null) {
    var state = this._spdyState
    Object.keys(state.stream.map).forEach(function (id) {
      var stream = state.stream.map[id]

      stream.destroy()
      if (err) {
        stream.emit('error', err)
      }
    })
  }

  isServer () {
    return this._spdyState.isServer
  }

  getXForwardedFor () {
    return this._spdyState.xForward
  }

  sendXForwardedFor (host: string) {
    var state = this._spdyState
    if (state.version !== null) {
      state.framer.xForwardedFor({ host: host })
    } else {
      state.xForward = host
    }
  }

  async pushPromise (parent: Stream, uri: CreatePushOptions) {
    var state = this._spdyState

    var stream = this._createStream({
      request: false,
      parent: parent,
      method: uri.method,
      path: uri.path,
      host: uri.host,
      priority: uri.priority,
      headers: uri.headers,
      readable: false
    })

    // TODO(indutny): deduplicate this logic somehow
    if (this._isGoaway(stream.id)) {
      throw new Error('Can\'t send PUSH_PROMISE after GOAWAY')
    }

    if (uri.push && !state.acceptPush) {
      throw new Error(
        'Can\'t send PUSH_PROMISE, other side won\'t accept it')
    }

    await stream._sendPush(uri.status, uri.response)

    return stream
  }

  setTimeout (delay: number, callback?: ClassicCallback) {
    var state = this._spdyState

    state.timeout.set(delay, callback)
  }
}
