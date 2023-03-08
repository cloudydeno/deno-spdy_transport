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
      transform: async (data, ctlr) => {
        if (this.dead) return;
        this.buffer.push(data);

        await this._consume(ctlr);
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

  async _consume (ctlr: TransformStreamDefaultController<Tframe>) {
    var self = this

    async function next (frame?: Tframe | Tframe[] | null) {
      if (Array.isArray(frame)) {
        for (var i = 0; i < frame.length; i++) {
          ctlr.enqueue(frame[i])
        }
      } else if (frame) {
        // console.error('_consume:', frame)
        ctlr.enqueue(frame)
      }

      // Consume more packets
      if (sync) {
        await new Promise<void>(ok => queueMicrotask(ok));
      }
      await self._consume(ctlr);
      return;
    }

    if (this.dead) {
      return;
    }

    if (this.buffer.size < this.waiting) {
      // No data at all
      if (this.buffer.size === 0) {
        return;
      }

      // Partial DATA frame or something that we can process partially
      if (this.partial) {
        var partial = this.buffer.clone(this.buffer.size)
        this.buffer.skip(partial.size)
        this.waiting -= partial.size

        await this.executePartial(partial).then(next)
      }

      // We shall not do anything until we get all expected data
      return
    }

    var sync = true

    var content = this.buffer.clone(this.waiting)
    this.buffer.skip(this.waiting)

    const promise = this.execute(content).then(next)
    sync = false
    await promise;
  }

  setVersion (version: number) {
    this.version = version
    this.emit('version', version)
  }

  setCompression (pair: CompressionPair) {
    this.decompress = new LockStream(pair.decompress)
  }

  abstract execute(buffer: OffsetBuffer): Promise<Tframe | Tframe[] | null>;
  abstract executePartial(buffer: OffsetBuffer): Promise<Tframe | Tframe[] | null>;
}
