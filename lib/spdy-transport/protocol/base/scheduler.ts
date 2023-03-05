import { binaryLookup } from '../../utils.ts';

// var debug = require('node:debug')('spdy:scheduler')
import { assertEquals } from "https://deno.land/std@0.170.0/testing/asserts.ts";
import { EventEmitter } from 'node:events';

/*
 * We create following structure in `pending`:
 * [ [ id = 0 ], [ id = 1 ], [ id = 2 ], [ id = 0 ] ]
 *     chunks      chunks      chunks      chunks
 *     chunks                  chunks
 *     chunks
 *
 * Then on the `.tick()` pass we pick one chunks from each item and remove the
 * item if it is empty:
 *
 * [ [ id = 0 ], [ id = 2 ] ]
 *     chunks      chunks
 *     chunks
 *
 * Writing out: chunks for 0, chunks for 1, chunks for 2, chunks for 0
 *
 * This way data is interleaved between the different streams.
 */

export type WritableData = {
  stream: number,
  priority: false | number,
  chunks: Uint8Array[],
  callback?: (err?: Error | null) => void;
}

export class Scheduler extends EventEmitter {
  windowSize: number;
  sync: WritableData[];
  list: SchedulerItem[];
  count: number;
  pendingTick: boolean;
  readable: ReadableStream<Uint8Array>;
  ctlr!: ReadableStreamDefaultController<Uint8Array>;

  constructor (options?: {
    window?: number;
  }) {
    super();

    this.pendingTick = true
    this.readable = new ReadableStream({
      start: (ctlr) => {
        this.ctlr = ctlr;
        this.pendingTick = false;
        this._read();
      }
    })

    // Pretty big window by default
    this.windowSize = options?.window ?? 0.25
    // ... but that isn't a Window instance!??!
    // this.windowSize = options.window;

    this.sync = []
    this.list = []
    this.count = 0
    this.pendingTick = false
  }

  // Just for testing, really
  // static create (options?: {
  //   window?: number;
  // }) {
  //   return new Scheduler(options)
  // }

  schedule (data: WritableData) {
    var priority = data.priority
    var stream = data.stream
    var chunks = data.chunks

    // Synchronous frames should not be interleaved
    if (priority === false) {
      // debug('queue sync', chunks)
      this.sync.push(data)
      this.count += chunks.length

      this._read()
      return
    }

    // debug('queue async priority=%d stream=%d', priority, stream, chunks)
    var item = new SchedulerItem(stream, priority)
    var index = binaryLookup(this.list, item, insertCompare)

    // Push new item
    if (index >= this.list.length || insertCompare(this.list[index], item) !== 0) {
      this.list.splice(index, 0, item)
    } else { // Coalesce
      item = this.list[index]
    }

    item.push(data)

    this.count += chunks.length

    this._read()
  }

  _read () {
    if (this.count === 0) {
      return
    }

    if (this.pendingTick) {
      return
    }
    this.pendingTick = true

    var self = this
    queueMicrotask(function () {
      self.pendingTick = false
      self.tick()
    })
  }

  tick () {
    // No luck for async frames
    if (!this.tickSync()) { return false }

    return this.tickAsync()
  }

  tickSync () {
    // Empty sync queue first
    var sync = this.sync
    var res = true
    this.sync = []
    for (var i = 0; i < sync.length; i++) {
      var item = sync[i]
      // debug('tick sync pending=%d', this.count, item.chunks)
      for (var j = 0; j < item.chunks.length; j++) {
        this.count--
        // TODO: handle stream backoff properly
        try {
          this.ctlr.enqueue(item.chunks[j])
        } catch (err) {
          this.emit('error', err)
          return false
        }
      }
      // debug('after tick sync pending=%d', this.count)

      // TODO(indutny): figure out the way to invoke callback on actual write
      if (item.callback) {
        item.callback(null)
      }
    }
    return res
  }

  tickAsync () {
    var res = true
    var list = this.list
    if (list.length === 0) {
      return res
    }

    var startPriority = list[0].priority
    for (var index = 0; list.length > 0; index++) {
      // Loop index
      index %= list.length
      if ((+startPriority) - (+list[index].priority) > this.windowSize) { index = 0 }
      // debug('tick async index=%d start=%d', index, startPriority)

      var current = list[index]
      var item = current.shift()!

      if (current.isEmpty()) {
        list.splice(index, 1)
        if (index === 0 && list.length > 0) {
          startPriority = list[0].priority
        }
        index--
      }

      // debug('tick async pending=%d', this.count, item.chunks)
      for (var i = 0; i < item.chunks.length; i++) {
        this.count--
        // TODO: handle stream backoff properly
        try {
          this.ctlr.enqueue(item.chunks[i])
        } catch (err) {
          this.emit('error', err)
          return false
        }
      }
      // debug('after tick pending=%d', this.count)

      // TODO(indutny): figure out the way to invoke callback on actual write
      if (item.callback) {
        item.callback(null)
      }
      if (!res) { break }
    }

    return res
  }

  dump () {
    this.tickSync()

    // Write everything out
    while (!this.tickAsync()) {
      // Intentional no-op
    }
    assertEquals(this.count, 0)
  }
}

class SchedulerItem {
  stream: number;
  priority: false | number;
  queue: WritableData[];
  constructor (stream: number, priority: false | number) {
    this.stream = stream
    this.priority = priority
    this.queue = []
  }

  push (chunks: WritableData) {
    this.queue.push(chunks)
  }

  shift () {
    return this.queue.shift()
  }

  isEmpty () {
    return this.queue.length === 0
  }
}

function insertCompare (a: SchedulerItem, b: SchedulerItem) {
  return a.priority === b.priority
    ? a.stream - b.stream
    : (+b.priority) - (+a.priority)
}
