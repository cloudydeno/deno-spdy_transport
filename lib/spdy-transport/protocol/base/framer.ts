import { LockStream, Timeout } from '../../utils.ts';
import { CompressionPair } from '../spdy/zlib-pool.ts'
import { Scheduler } from './scheduler.ts';
import { Window } from '../../window.ts'

export type FramerOptions = {
  window: Window;
  timeout: Timeout;
};

export class Framer extends Scheduler {
  version: number | null;
  compress: LockStream | null;
  window: Window;
  timeout: Timeout;
  pushEnabled: boolean | null;

  constructor(options: FramerOptions) {
    super();

    this.version = null
    this.compress = null
    this.window = options.window
    this.timeout = options.timeout

    // Wait for `enablePush`
    this.pushEnabled = null
  }

  setVersion (version: number) {
    this.version = version
    this.emit('version')
  }

  setCompression (pair: CompressionPair) {
    this.compress = new LockStream(pair.compress)
  }

  enablePush (enable: boolean) {
    this.pushEnabled = enable
    this.emit('_pushEnabled')
  }

  async _checkPush () {
    if (this.pushEnabled === null) {
      await new Promise(ok => this.once('_pushEnabled', ok));
    }

    if (!this.pushEnabled) {
      throw new Error('PUSH_PROMISE disabled by other side')
    }
  }

  _resetTimeout () {
    this.timeout?.reset()
  }
}
