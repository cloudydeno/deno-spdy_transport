import EventEmitter from "node:events";
import type { Buffer } from "node:buffer";
import type { Deflate, Inflate } from "node:zlib";
import type { ClassicCallback } from "./protocol/types.ts";

export class QueueItem {
  prev: null | QueueItem;
  next: null | QueueItem;
  constructor() {
    this.prev = null
    this.next = null
  }
}

export class Queue extends QueueItem {
  constructor() {
    super();
    this.prev = this
    this.next = this
  }

  insertTail(item: QueueItem) {
    item.prev = this.prev
    item.next = this
    item.prev!.next = item
    item.next.prev = item
  }

  remove(item: QueueItem) {
    const next = item.next
    const prev = item.prev

    item.next = item
    item.prev = item
    next!.prev = prev
    prev!.next = next
  }

  head() {
    return this.next
  }

  tail() {
    return this.prev
  }

  isEmpty() {
    return this.next === this
  }

  isRoot(item: QueueItem) {
    return this === item
  }
}

export class LockStream {
  locked: boolean;
  queue: Array<() => void>
  stream: Inflate | Deflate;

  constructor (stream: Inflate | Deflate) {
    this.locked = false
    this.queue = []
    this.stream = stream
  }

  write (chunks: Uint8Array[], callback: ClassicCallback<Uint8Array[]>) {
    // Do not let it interleave
    if (this.locked) {
      this.queue.push(() => {
        return this.write(chunks, callback)
      })
      return
    }

    this.locked = true

    const done = (err?: Error | null, chunks?: Uint8Array[]) => {
      this.stream.removeListener('error', done)

      this.locked = false
      if (this.queue.length > 0) { this.queue.shift()!() }
      callback(err, chunks)
    }

    this.stream.on('error', done)

    // Accumulate all output data
    const output: Uint8Array[] = []
    function onData (chunk: Buffer) {
      output.push(chunk)
    }
    this.stream.on('data', onData)

    const next = (err?: Error | null) => {
      this.stream.removeListener('data', onData)
      if (err) {
        return done(err)
      }

      done(null, output)
    }

    let i: number;
    for (i = 0; i < chunks.length - 1; i++) { this.stream.write(chunks[i]) }

    if (chunks.length > 0) {
      this.stream.write(chunks[i], next)
    } else { queueMicrotask(next) }

    // if ((this.stream as any).execute) {
    //   console.error(`stream execute`);
    //   (this.stream as any).execute(function (err?: Error | null) {
    //     if (err) { return done(err) }
    //   })
    // }
  }
}

export abstract class QueuingMutex<Tin,Tout> {
  locked = false
  queue = new Array<() => void>()

  constructor (
    // private readonly innerFunc: (param: Tin) => Promise<Tout>
  ) {}

  abstract transformOne(chunks: Tin): Promise<Tout>;

  async use (param: Tin) {

    // Do not let it interleave
    await new Promise<void>(ok => {
      if (this.locked) {
        this.queue.push(() => {
          this.locked = true;
          ok();
        });
      } else {
        this.locked = true;
        ok();
      }
    })

    try {
      return await this.transformOne(param);
    } finally {
      this.locked = false
      this.queue.shift()?.();
    }
  }
}

export class InflateDeflateQueue extends QueuingMutex<Uint8Array[],Uint8Array[]> {
  constructor(
    private readonly stream: Inflate | Deflate,
  ) {
    super();
  }

  async transformOne(chunks: Uint8Array[]): Promise<Uint8Array[]> {

    // Accumulate all output data
    const output: Uint8Array[] = []
    function onData (chunk: Buffer) {
      output.push(chunk)
    }
    this.stream.on('data', onData)

    try {
      for (const chunk of chunks) {
        await new Promise<void>((ok, fail) => {
          this.stream.write(chunk, err => err ? fail(err) : ok());
        });
      }

      return output;
    } finally {
      this.stream.removeListener('data', onData)
    }
  }
}

// Just finds the place in array to insert
export function binaryLookup<T> (list: T[], item: T, compare: (a: T, b: T) => number) {
  let start = 0
  let end = list.length

  while (start < end) {
    const pos = (start + end) >> 1
    const cmp = compare(item, list[pos])

    if (cmp === 0) {
      start = pos
      end = pos
      break
    } else if (cmp < 0) {
      end = pos
    } else {
      start = pos + 1
    }
  }

  return start
}

export function binaryInsert<T> (list: T[], item: T, compare: (a: T, b: T) => number) {
  const index = binaryLookup(list, item, compare)

  list.splice(index, 0, item)
}

export function binarySearch<T> (list: T[], item: T, compare: (a: T, b: T) => number) {
  const index = binaryLookup(list, item, compare)

  if (index >= list.length) {
    return -1
  }

  if (compare(item, list[index]) === 0) {
    return index
  }

  return -1
}

export class Timeout {
  delay: number;
  timer: null | number;
  object: EventEmitter;

  constructor(object: EventEmitter) {
    this.delay = 0
    this.timer = null
    this.object = object
  }

  set (delay: number, callback?: ClassicCallback) {
    this.delay = delay
    this.reset()
    if (!callback) { return }

    if (this.delay === 0) {
      this.object.removeListener('timeout', callback)
    } else {
      this.object.once('timeout', callback)
    }
  }

  reset () {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.delay === 0) { return }

    this.timer = setTimeout(() => {
      this.timer = null
      this.object.emit('timeout')
    }, this.delay)
  }
}

/** Return a hex representation of a byte-buffer */
export function bytesAsHex(buffer: Uint8Array) {
  return [...buffer].map(x => x.toString(16).padStart(2, '0')).join(' ');
}
