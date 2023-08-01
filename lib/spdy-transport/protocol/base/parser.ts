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

        // Read as many full frames as we can find
        while (this.buffer.size >= this.waiting) {
          const content = this.buffer.clone(this.waiting)
          this.buffer.skip(this.waiting)

          const frames = await this.execute(content);
          for (const frame of frames) {
            ctlr.enqueue(frame);
          }
        }

        // Partial DATA frame or something that we can process partially
        if (this.partial && this.buffer.size > 0) {
          const partial = this.buffer.clone(this.buffer.size)
          this.buffer.skip(partial.size)
          this.waiting -= partial.size

          const frames = await this.executePartial(partial);
          for (const frame of frames) {
            ctlr.enqueue(frame);
          }
        }
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

  kill () {
    this.dead = true
  }

  setVersion (version: number) {
    this.version = version
    this.emit('version', version)
  }

  setCompression (pair: CompressionPair) {
    this.decompress = new LockStream(pair.decompress)
  }

  abstract execute(buffer: OffsetBuffer): Promise<Tframe[]>;
  abstract executePartial(buffer: OffsetBuffer): Promise<Tframe[]>;
}
