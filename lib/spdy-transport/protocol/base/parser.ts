// import OffsetBuffer from 'npm:obuf'
// import { Transform } from 'npm:readable-stream'
import { error } from './utils.ts'
import { Window } from '../../window.ts'
import { OffsetBuffer } from "../../../obuf.ts";
import EventEmitter from "node:events";
import { LockStream } from "../../utils.ts";
import { CompressionPair } from '../spdy/zlib-pool.ts';

export abstract class Parser<Tframe> extends EventEmitter {
  buffer: OffsetBuffer;
  partial: boolean;
  waiting: number;
  window: Window;
  version: number | null;
  decompress: LockStream | null;
  dead: boolean;
  transformStream: TransformStream<Uint8Array,Tframe>;

  constructor (options: {
    window: Window,
  }) {
    super();

    this.transformStream = new TransformStream({
      // readableObjectMode: true
      transform: (data, ctlr) => {
        if (!this.dead) { this.buffer.push(data) }

        return new Promise((ok, fail) => {
          this._consume(ctlr, err => err ? fail(err) : ok());
        });
      },
    });

    this.buffer = new OffsetBuffer()
    this.partial = false
    this.waiting = 0

    this.window = options.window

    this.version = null
    this.decompress = null
    this.dead = false
  }

  static create (options: ConstructorParameters<typeof Parser>[0]) {
    throw new Error(`is abstract`);
  }

  error = error

  kill () {
    this.dead = true
  }

  // _transform (data, encoding, cb) {
  //   if (!this.dead) { this.buffer.push(data) }

  //   this._consume(cb)
  // }

  _consume (ctlr: TransformStreamDefaultController<Tframe>, cb: (err?: Error) => void) {
    var self = this

    function next (err?: Error | null, frame?: Tframe | Tframe[] | null) {
      if (err) {
        return cb(err)
      }

      if (Array.isArray(frame)) {
        for (var i = 0; i < frame.length; i++) {
          ctlr.enqueue(frame[i])
        }
      } else if (frame) {
        ctlr.enqueue(frame)
      }

      // Consume more packets
      if (!sync) {
        return self._consume(ctlr, cb)
      }

      queueMicrotask(function () {
        self._consume(ctlr, cb)
      })
    }

    if (this.dead) {
      return cb()
    }

    if (this.buffer.size < this.waiting) {
      // No data at all
      if (this.buffer.size === 0) {
        return cb()
      }

      // Partial DATA frame or something that we can process partially
      if (this.partial) {
        var partial = this.buffer.clone(this.buffer.size)
        this.buffer.skip(partial.size)
        this.waiting -= partial.size

        this.executePartial(partial, next)
        return
      }

      // We shall not do anything until we get all expected data
      return cb()
    }

    var sync = true

    var content = this.buffer.clone(this.waiting)
    this.buffer.skip(this.waiting)

    this.execute(content, next)
    sync = false
  }

  setVersion (version: number) {
    this.version = version
    this.emit('version', version)
  }

  setCompression (pair: CompressionPair) {
    this.decompress = new LockStream(pair.decompress)
  }

  abstract execute(buffer: OffsetBuffer, callback: (
    err?: Error | null,
    frame?: Tframe | Tframe[] | null,
  ) => void): void;
  abstract executePartial(buffer: OffsetBuffer, callback: (
    err?: Error | null,
    frame?: Tframe | Tframe[] | null,
  ) => void): void;
}
