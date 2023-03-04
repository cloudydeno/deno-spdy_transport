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

  _checkPush (callback: (err?: Error | null) => void) {
    if (this.pushEnabled === null) {
      this.once('_pushEnabled', () => {
        this._checkPush(callback)
      })
      return
    }

    var err: Error | null = null
    if (!this.pushEnabled) {
      err = new Error('PUSH_PROMISE disabled by other side')
    }
    queueMicrotask(function () {
      return callback(err)
    })
  }

  _resetTimeout () {
    if (this.timeout) {
      this.timeout.reset()
    }
  }
}
