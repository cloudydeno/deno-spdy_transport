// var debug = {
//   client: require('debug')('spdy:stream:client'),
//   server: require('debug')('spdy:stream:server')
// }
// import { Duplex } from 'npm:readable-stream';
import { Connection, CreatePushOptions } from "./connection.ts";
import { Window } from "./window.ts";
import { Timeout } from './utils.ts'
import EventEmitter from "node:events";
import { PriorityJson, PriorityNode } from "./priority.ts";
import { Framer } from "./protocol/spdy/framer.ts";
import { Parser } from "./protocol/spdy/parser.ts";
import { DataFrame, FrameUnion, SpdyHeaders } from "./protocol/types.ts";
import { ClassicCallback } from "./protocol/types.ts";
import { CreateStreamOptions } from "./connection.ts";
import { constants } from "./protocol/spdy/index.ts";
import { assert } from "https://deno.land/std@0.170.0/testing/asserts.ts";

type SpdyStreamState = {
  protocol: unknown;
  constants: unknown;
  priority: PriorityNode | null;
  version: unknown;
  isServer: unknown;
  framer: Framer;
  parser: Parser;
  request: unknown;
  needResponse: unknown;
  window: Window;
  sessionWindow: Window;
  maxChunk: number;
  sent: boolean;
  readable: boolean;
  writable: boolean;
  aborted: boolean;
  corked: number;
  corkQueue: (() => void)[];
  timeout: Timeout;
};

export class Stream extends EventEmitter {
  id: number;
  method: string;
  path: string;
  host?: string;
  headers: SpdyHeaders;
  connection: Connection;
  parent: Stream | null;

  _spdyState: SpdyStreamState;

  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  aborted?: boolean;

  private _writableStateFinished: boolean;
  private _inboundData: WritableStreamDefaultWriter<Uint8Array> | null = null;

  constructor (connection: Connection, options: CreateStreamOptions & {
    id: number;
  }) {
    super()

    this._writableStateFinished = false;
    this.writable = new WritableStream({
      start: (ctlr) => {
        if (options.writable === false) {
          ctlr.error(`not writable`);
        }
      },
      write: (chunk) => this._write(chunk),
      close: async () => {
        this._writableStateFinished = true;
        // TODO: confirm this
        // state.timeout.set(0)
        // this.emit('close')
        await state.framer.dataFrame({
          id: this.id,
          priority: state.priority!.getPriority(),
          fin: true,
          data: new Uint8Array(0),
        })
      },
    })


    const inboundDataPipe = new TransformStream<Uint8Array>();
    this.readable = inboundDataPipe.readable;
    this._inboundData = inboundDataPipe.writable.getWriter();

    var connectionState = connection._spdyState

    this.id = options.id
    this.method = options.method
    this.path = options.path
    this.host = options.host
    this.headers = options.headers || {}
    this.connection = connection
    this.parent = options.parent || null

    var state = this._spdyState = {
      protocol: connectionState.protocol,
      constants: connectionState.protocol.constants,

      priority: this._initPriority(options.priority),

      version: this.connection.getVersion(),
      isServer: this.connection.isServer(),
      // state.debug = state.isServer ? debug.server : debug.client

      framer: connectionState.framer,
      parser: connectionState.parser,

      request: options.request,
      needResponse: options.request,
      window: connectionState.streamWindow.clone(options.id),
      sessionWindow: connectionState.window,
      maxChunk: connectionState.maxChunk,

      // Can't send incoming request
      // (See `.send()` method)
      sent: !options.request,

      readable: options.readable !== false,
      writable: options.writable !== false,

      aborted: false,

      corked: 0,
      corkQueue: [],

      timeout: new Timeout(this),
    }

    this.on('finish', this._onFinish)
    this.on('end', this._onEnd)

    state.window.recv.on('overflow', () => this._onWindowOverflow())
    state.window.send.on('overflow', () => this._onWindowOverflow())


    // if (!state.readable) { this.ctlr?.close(null) }
    // if (!state.writable) {
    //   this._writableState.ended = true
    //   this._writableStateFinished = true
    // }
  }

  _initPriority (priority?: PriorityJson | null) {
    var connectionState = this.connection._spdyState
    var root = connectionState.priorityRoot

    if (!priority) {
      return root.addDefault(this.id)
    }

    return root.add({
      id: this.id,
      parent: priority.parent,
      weight: priority.weight,
      exclusive: priority.exclusive
    })
  }

  async _handleFrame(frame: FrameUnion) {
    const state = this._spdyState;
    state.timeout.reset()

    switch (frame.type) {
    case 'DATA':
      if (!state.readable || !this._inboundData) {
        // DATA on ended or not readable stream!
        console.error(`WARN: DATA on ended or not readable stream!`);
        state.framer.rstFrame({ id: this.id, code: 'STREAM_CLOSED' })
      } else {
        state.window.recv.update(-frame.data.length)
        await this._inboundData.ready;
        await this._inboundData.write(frame.data);
      }
      break;
    case 'HEADERS':
      this._handleHeaders(frame);
      break;
    case 'RST':
      this._handleRST(frame);
      break;
    case 'WINDOW_UPDATE':
      this._handleWindowUpdate(frame);
      break;
    case 'PRIORITY':
      this._handlePriority(frame);
      break;
    case 'PUSH_PROMISE':
      this._handlePushPromise(frame);
      break;
    }

    if ((frame as DataFrame).fin && this._inboundData) {
      await this._inboundData.close();
      this._inboundData = null;
    }
  }

  async _write (data: Uint8Array) {
    var state = this._spdyState

    // Send the request if it wasn't sent
    if (!state.sent) { this.send() }

    // Writes should come after pending control frames (response and headers)
    if (state.corked !== 0) {
      await new Promise<void>(ok => state.corkQueue.push(ok));
    }

    // Split DATA in chunks to prevent window from going negative
    await this._splitStart(data, _send)
  }

  async _splitStart (data: Uint8Array, onChunk: (stream: Stream, state: SpdyStreamState, chunk: Uint8Array) => Promise<void>) {
    await this._split(data, 0, onChunk)
  }

  async _split (data: Uint8Array, offset: number, onChunk: (stream: Stream, state: SpdyStreamState, chunk: Uint8Array) => Promise<void>): Promise<void> {
    if (offset === data.length) {
      return
    }

    var state = this._spdyState
    var local = state.window.send
    var session = state.sessionWindow.send

    var availSession = Math.max(0, session.getCurrent())
    if (availSession === 0) {
      availSession = session.getMax()
    }
    var availLocal = Math.max(0, local.getCurrent())
    if (availLocal === 0) {
      availLocal = local.getMax()
    }

    var avail = Math.min(availSession, availLocal)
    avail = Math.min(avail, state.maxChunk)

    var self = this

    if (avail === 0) {
      await new Promise(ok => state.window.send.update(0, ok));
      return await this._split(data, offset, onChunk);
    }

    // Split data in chunks in a following way:
    var limit = avail
    var size = Math.min(data.length - offset, limit)

    var chunk = data.slice(offset, offset + size)

    await onChunk(this, state, chunk);

    // Get the next chunk
    return await self._split(data, offset + size, onChunk);
  }

  // TODO: is it ok that this is never called?
  _read () {
    var state = this._spdyState

    if (!state.window.recv.isDraining()) {
      return
    }

    var delta = state.window.recv.getDelta()

    // state.debug('id=%d window emptying, update by %d', this.id, delta)

    state.window.recv.update(delta)
    state.framer.windowUpdateFrame({
      id: this.id,
      delta: delta
    })
  }

  _handleRST (frame: {
    code: keyof typeof constants.error;
  }) {
    if (frame.code !== 'CANCEL') {
      this.emit('error', new Error('Got RST: ' + frame.code))
    }
    this.abort()
  }

  _handleWindowUpdate (frame: {
    delta: number;
  }) {
    var state = this._spdyState

    state.window.send.update(frame.delta)
  }

  _onWindowOverflow () {
    var state = this._spdyState

    // state.debug('id=%d window overflow', this.id)
    state.framer.rstFrame({ id: this.id, code: 'FLOW_CONTROL_ERROR' })

    this.aborted = true
    this.emit('error', new Error('HTTP2 window overflow'))
  }

  _handlePriority (frame: {
    priority: PriorityJson;
  }) {
    var state = this._spdyState

    state.priority!.remove()
    state.priority = null
    this._initPriority(frame.priority)

    // Mostly for testing purposes
    this.emit('priority', frame.priority)
  }

  _handleHeaders (frame: {
    headers: SpdyHeaders;
  }) {
    var state = this._spdyState

    if (!state.readable || !this._inboundData) {
      state.framer.rstFrame({ id: this.id, code: 'STREAM_CLOSED' })
      return
    }

    if (state.needResponse) {
      return this._handleResponse(frame)
    }

    this.emit('headers', frame.headers)
  }

  _handleResponse (frame: {
    headers: SpdyHeaders;
  }) {
    var state = this._spdyState

    // TODO: why? for kubernetes?
    frame.headers[':status'] ??= 0

    if (frame.headers[':status'] === undefined) {
      state.framer.rstFrame({ id: this.id, code: 'PROTOCOL_ERROR' })
      return
    }

    state.needResponse = false
    this.emit('response', (frame.headers[':status'] as number) | 0, frame.headers)
  }

  _onFinish () {
    var state = this._spdyState

    // Send the request if it wasn't sent
    if (!state.sent) {
      // NOTE: will send HEADERS with FIN flag
      this.send()
    } else {
      // Just an `.end()` without any writes will trigger immediate `finish` event
      // without any calls to `_write()`.
      if (state.corked !== 0) {
        var self = this
        state.corkQueue.push(function () {
          self._onFinish()
        })
        return
      }

      state.framer.dataFrame({
        id: this.id,
        priority: state.priority!.getPriority(),
        fin: true,
        data: new Uint8Array(0),
      })
    }

    this._maybeClose()
  }

  _onEnd () {
    this._maybeClose()
  }

  _checkEnded () {
    var state = this._spdyState

    var ended = false
    if (state.aborted) { ended = true }

    if (!state.writable || this._writableStateFinished) { ended = true }

    if (!ended) {
      return true
    }

    // if (!callback) {
    //   return false
    // }

    throw new Error('Ended stream can\'t send frames')
    // queueMicrotask(function () {
    //   callback(err)
    // })

    // return false
  }

  _maybeClose () {
    var state = this._spdyState

    // .abort() emits `close`
    if (state.aborted) {
      return
    }

    if ((!state.readable || !this._inboundData) &&
        this._writableStateFinished) {
      // Clear timeout
      state.timeout.set(0)

      this.emit('close')
    }
  }

  _handlePushPromise (frame: {
    promisedId: number;
    headers: SpdyHeaders,
    priority?: PriorityJson;
  }) {
    var push = this.connection._createStream({
      id: frame.promisedId,
      parent: this,
      push: true,
      request: true,
      method: `${frame.headers[':method']}`,
      path: `${frame.headers[':path']}`,
      host: `${frame.headers[':authority']}`,
      priority: frame.priority,
      headers: frame.headers,
      writable: false
    })

    // GOAWAY
    if (this.connection._isGoaway(push.id)) {
      return
    }

    if (!this.emit('pushPromise', push)) {
      push.abort()
    }
  }

  _hardCork () {
    var state = this._spdyState

    // this.cork()
    state.corked++
  }

  _hardUncork () {
    var state = this._spdyState

    // this.uncork()
    state.corked--
    if (state.corked !== 0) {
      return
    }

    // Invoke callbacks
    var queue = state.corkQueue
    state.corkQueue = []
    for (var i = 0; i < queue.length; i++) {
      queue[i]()
    }
  }

  async _sendPush (status: number, response: SpdyHeaders) {
    var self = this
    var state = this._spdyState

    this._hardCork()
    await state.framer.pushFrame({
      id: this.parent!.id,
      promisedId: this.id,
      priority: state.priority!.toJSON(),
      path: this.path,
      host: this.host,
      method: this.method,
      status: status,
      headers: this.headers,
      response: response
    })
    self._hardUncork()
  }

  _wasSent () {
    var state = this._spdyState
    return state.sent
  }

  // Public API

  async send () {
    var state = this._spdyState

    if (state.sent) {
      throw new Error('Stream was already sent')
    }

    state.sent = true
    state.timeout.reset()

    // TODO(indunty): ideally it should just take a stream object as an input
    var self = this
    this._hardCork()
    await state.framer.requestFrame({
      id: this.id,
      method: this.method,
      path: this.path,
      host: this.host,
      priority: state.priority!.toJSON(),
      headers: this.headers,
      fin: this._writableStateFinished,
    });
    self._hardUncork()

    // GET requests should always be auto-finished
    if (!state.writable) {// this.method === 'GET') {
      // this.writable.close();
      await state.framer.dataFrame({
        id: this.id,
        priority: state.priority!.getPriority(),
        fin: true,
        data: new Uint8Array(0),
      })
      // this._writableState.ended = true
      // this._writableStateFinished = true
    }
  }

  async respond (status: keyof typeof constants.statusReason, headers: SpdyHeaders, callback: ClassicCallback) {
    var self = this
    var state = this._spdyState
    assert(!state.request, 'Can\'t respond on request')

    state.timeout.reset()

    this._checkEnded();

    var frame = {
      id: this.id,
      status: status,
      headers: headers
    }
    this._hardCork()
    await state.framer.responseFrame(frame);
    self._hardUncork()
  }

  setWindow (size: number) {
    var state = this._spdyState

    state.timeout.reset()

    this._checkEnded();

    // state.debug('id=%d force window max=%d', this.id, size)
    state.window.recv.setMax(size)

    var delta = state.window.recv.getDelta()
    if (delta === 0) { return }

    state.framer.windowUpdateFrame({
      id: this.id,
      delta: delta
    })
    state.window.recv.update(delta)
  }

  async sendHeaders (headers: SpdyHeaders) {
    var self = this
    var state = this._spdyState

    state.timeout.reset()

    this._checkEnded();

    // Request wasn't yet send, coalesce headers
    if (!state.sent) {
      this.headers = Object.assign({}, this.headers)
      Object.assign(this.headers, headers)
      return
    }

    this._hardCork()
    await state.framer.headersFrame({
      id: this.id,
      headers: headers
    });
    self._hardUncork()
  }

  destroy () {
    this.abort()
  }

  async abort (code?: keyof typeof constants.error) {
    var state = this._spdyState

    if ((!this._spdyState.readable || !this._inboundData) && this._writableStateFinished) {
      // state.debug('id=%d already closed', this.id)
      return
    }

    if (state.aborted) {
      // state.debug('id=%d already aborted', this.id)
      return
    }

    state.aborted = true
    // state.debug('id=%d abort', this.id)

    this.setTimeout(0)

    var abortCode = code || 'CANCEL'

    if (this.connection._spdyState.alive) {
      state.framer.rstFrame({
        id: this.id,
        code: abortCode
      })
    }

    // await new Promise<void>(ok => queueMicrotask(ok));

    if (abortCode == 'CANCEL') {
      this._inboundData?.close();
    } else {
      this._inboundData?.abort(new Error('Aborted, code: ' + abortCode));
    }
    this._inboundData = null;
    // this.emit('close', new Error('Aborted, code: ' + abortCode))
  }

  setPriority (info: PriorityJson) {
    var state = this._spdyState

    state.timeout.reset()

    this._checkEnded();

    // state.debug('id=%d priority change', this.id, info)

    var frame = { id: this.id, priority: info }

    // Change priority on this side
    this._handlePriority(frame)

    // And on the other too
    state.framer.priorityFrame(frame)
  }

  async pushPromise (uri: CreatePushOptions, callback: ClassicCallback<Stream>) {
    this._checkEnded();

    var self = this
    this._hardCork()

    try {
      var push = await this.connection.pushPromise(this, uri);
      push._hardCork()
    } finally {
      self._hardUncork()
    }

    return push
  }

  setMaxChunk (size: number) {
    var state = this._spdyState
    state.maxChunk = size
  }

  setTimeout (delay: number, callback?: ClassicCallback) {
    var state = this._spdyState

    state.timeout.set(delay, callback)
  }
}

function checkAborted (stream: Stream, state: SpdyStreamState) {
  if (state.aborted) {
    // state.debug('id=%d abort write', stream.id)
    throw new Error('Stream write aborted');
  }

  // return false
}

async function _send (stream: Stream, state: SpdyStreamState, data: Uint8Array) {
  checkAborted(stream, state);

  // state.debug('id=%d presend=%d', stream.id, data.length)

  state.timeout.reset()

  await new Promise(ok => state.window.send.update(-data.length, ok));
  checkAborted(stream, state);

    // state.debug('id=%d send=%d', stream.id, data.length)

  state.timeout.reset()

  await state.framer.dataFrame({
    id: stream.id,
    priority: state.priority!.getPriority(),
    fin: false,
    data: data
  })
  // state.debug('id=%d postsend=%d', stream.id, data.length)
}
