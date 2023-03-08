import { binaryLookup } from '../../utils.ts';

// var debug = require('node:debug')('spdy:scheduler')
import { assertEquals } from "https://deno.land/std@0.170.0/testing/asserts.ts";
import { EventEmitter } from 'node:events';

export type WritableData = {
  stream: number,
  priority: false | number,
  chunks: Uint8Array[],
  callback?: (err?: Error | null) => void;
}

/**
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

export class Scheduler extends EventEmitter {
  windowSize: number;
  sync: WritableData[];
  list: SchedulerItem[];
  count: number;
  readable: ReadableStream<Uint8Array>;
  waitingCb: (() => void) | null = null;

  constructor (options?: {
    window?: number;
  }) {
    super();

    // Pretty big window by default
    this.windowSize = options?.window ?? 0.25

    this.sync = []
    this.list = []
    this.count = 0

    this.readable = new ReadableStream({
      pull: async ctlr => {

        while (this.count > 0 && (ctlr.desiredSize ?? 1) > 0) {
          for (const item of this.sweepQueueOnce()) {
            ctlr.enqueue(item);
          }
          // Assuming we have a desiredSize, stop enqueueing if it's below 1
          if ((ctlr.desiredSize ?? 0) <= 0) return;
        }

        // We don't have anything to send so we set up a hook for later
        await new Promise<void>(ok => {
          this.waitingCb = ok;
        });
      },
    }, {
      highWaterMark: 5, // How many frames should be pulled at a time
    })
  }

  findQueue(stream: number, priority: number | false) {
    if (priority === false) {
      return this.sync;
    }

    var item: SchedulerItem = { stream, priority, queue: [] };
    var index = binaryLookup(this.list, item, insertCompare)

    if (index >= this.list.length || insertCompare(this.list[index], item) !== 0) {
      // Create new item
      this.list.splice(index, 0, item)
    } else { // Coalesce
      item = this.list[index]
    }

    return item.queue;
  }

  schedule (data: WritableData) {
    const queue = this.findQueue(data.stream, data.priority);

    queue.push(data);
    this.count += data.chunks.length;

    if (this.waitingCb) {
      this.waitingCb();
      this.waitingCb = null;
    }
  }

  *sweepQueueOnce () {
    // Synchronous frames should not be interleaved
    const shifted = this.sync.shift();
    if (shifted) {
      yield* shifted.chunks;
      this.count -= shifted.chunks.length;
      shifted.callback?.();
      return;
    }

    if (this.count === 0) {
      // Nothing left to send.
      return
    }

    var startPriority = this.list[0].priority
    for (const current of this.list) {
      if (startPriority - current.priority > this.windowSize) break;

      const item = current.queue.shift()!
      if (item) {
        yield* item.chunks;
        this.count -= item.chunks.length;
        item.callback?.();
      }
    }

    // Remove any empty SchedulerItems
    this.list = this.list.filter(x => x.queue.length > 0);
  }

  *flushAll () {
    while (this.count > 0) {
      yield* this.sweepQueueOnce();
    }
  }
}

type SchedulerItem = {
  stream: number;
  priority: number;
  queue: WritableData[];
}

function insertCompare (a: SchedulerItem, b: SchedulerItem) {
  return a.priority === b.priority
    ? a.stream - b.stream
    : (+b.priority) - (+a.priority)
}
