/* eslint-env mocha */

import { compressionPool } from "../../lib/spdy-transport/protocol/spdy/index.ts";
import { Parser } from "../../lib/spdy-transport/protocol/spdy/parser.ts";
import { Window } from "../../lib/spdy-transport/window.ts";
import { decode } from "https://deno.land/std@0.177.0/encoding/hex.ts";
import { EOF, external } from "https://deno.land/x/stream_observables@v1.3/sources/external.ts";
import { collect } from "https://deno.land/x/stream_observables@v1.3/sinks/collect.ts";
import { map } from "https://deno.land/x/stream_observables@v1.3/transforms/map.ts";
import { assertEquals, assertRejects, assertMatch, assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { FrameUnion } from "../../lib/spdy-transport/protocol/types.ts";
import { error } from "../../lib/spdy-transport/protocol/spdy/constants.ts";
import { ProtocolError } from "../../lib/spdy-transport/protocol/base/utils.ts";

// var spdy = spdy

class TestContext {
  window = new Window({
    id: 0,
    isServer: true,
    recv: { size: 1024 * 1024 },
    send: { size: 1024 * 1024 },
  })
  parser = new Parser({
    window: this.window,
    isServer: false,
  })

  receive: (hexStr: string | typeof EOF) => void; // Promise<void>;
  frameStream: ReadableStream<FrameUnion>;

  constructor() {
    const pool = new compressionPool(true)
    var comp = pool.get(3.1)
    this.parser.setCompression(comp)
    this.parser.skipPreface()

    const { observable, next } = external<string>();
    this.receive = next;
    this.frameStream = observable
      .pipeThrough(new TextEncoderStream())
      .pipeThrough(map(decode))
      .pipeThrough(this.parser.transformStream);
  }

  // async passNone (data: string) {
  //   this.receive(data);
  //   this.receive(EOF)
  //   await new Promise(ok => setTimeout(ok, 10));

  //   const frames = await collect(this.frameStream);

  //   assertEquals(frames, [])
  //   assertEquals(this.parser.buffer.size, 0)
  // }

  async pass (data: string, expected: FrameUnion | FrameUnion[]) {
    if (!Array.isArray(expected)) {
      expected = [ expected ]
    }

    this.receive(data);
    this.receive(EOF)
    await new Promise(ok => setTimeout(ok, 10));

    const frames = await collect(this.frameStream);

    assertEquals(frames, expected)
    assertEquals(this.parser.buffer.size, 0)
  }

  async passNext (data: string, expected: FrameUnion) {
    this.receive(data);
    await new Promise(ok => setTimeout(ok, 10));

    const reader = this.frameStream.getReader();
    const {done, value: frame} = await reader.read();
    reader.releaseLock();

    assert(frame);
    assertEquals(done, false);

    assertEquals(frame, expected)
    // assertEquals(this.parser.buffer.size, 0)
  }

  async fail (data: string, code: keyof typeof error, re: RegExp) {

    this.receive(data);
    this.receive(EOF)
    await new Promise(ok => setTimeout(ok, 10));

    const err = await assertRejects(() => collect(this.frameStream), ProtocolError);

      assertEquals(err.code, code)
      assertMatch(err.message, re);

    // parser.once('error', assert)
  }
}

Deno.test('SPDY Parser (v3)', async t => {

  await t.step('SYN_STREAM', async t => {
    await t.step('should parse frame with http header', async () => {
      var hexFrame = '800300010000002c0000000100000000000078' +
                      'f9e3c6a7c202e50e507ab442a45a77d7105006' +
                      'b32a4804974d8cfa00000000ffff'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        fin: false,
        headers: {
          ':method': 'GET',
          ':path': '/'
        },
        id: 1,
        path: '/',
        priority: {
          exclusive: false,
          parent: 0,
          weight: 1.0
        },
        type: 'HEADERS', // by spec 'SYN_STREAM'
        writable: true
      })
    })

    await t.step('should fail on stream ID 0', async function () {
      var hexFrame = '800300010000002c0000000000000000000078' +
                      'f9e3c6a7c202e50e507ab442a45a77d7105006' +
                      'b32a4804974d8cfa00000000ffff'

      const ctx = new TestContext()
      await ctx.fail(hexFrame, 'PROTOCOL_ERROR', /Invalid*/i)
    })

    await t.step('should parse frame with http header and FIN flag', async () => {
      var hexFrame = '800300010100002c0000000100000000000078' +
                      'f9e3c6a7c202e50e507ab442a45a77d7105006' +
                      'b32a4804974d8cfa00000000ffff'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        fin: true,
        headers: {
          ':method': 'GET',
          ':path': '/'
        },
        id: 1,
        path: '/',
        priority: {
          exclusive: false,
          parent: 0,
          weight: 1.0
        },
        type: 'HEADERS', // by spec 'SYN_STREAM'
        writable: true
      })
    })

    await t.step('should parse frame with unidirectional flag', async () => {
      var hexFrame = '800300010200002c0000000100000000000078' +
                      'f9e3c6a7c202e50e507ab442a45a77d7105006' +
                      'b32a4804974d8cfa00000000ffff'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        fin: false,
        headers: {
          ':method': 'GET',
          ':path': '/'
        },
        id: 1,
        path: '/',
        priority: {
          exclusive: false,
          parent: 0,
          weight: 1.0
        },
        type: 'HEADERS', // by spec 'SYN_STREAM'
        writable: false
      })
    })
  })

  await t.step('SYN_REPLY', async t => {
    await t.step('should parse a frame without headers', async () => {
      var hexFrame = '80030002000000140000000178f9e3c6a7c202a6230600000000ffff'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        fin: false,
        headers: {},
        id: 1,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS', // by spec SYN_REPLY
        writable: true
      })
    })

    await t.step('should parse a frame with headers', async () => {
      var hexFrame = '8003000200000057000000013830e3c6a7c2004300bcff' +
          '00000003000000057468657265000000057468657265000000073a737' +
          '46174757300000006323030204f4b000000083a76657273696f6e0000' +
          '0008485454502f312e31000000ffff'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        fin: false,
        headers: {
          ':status': '200',
          there: 'there'
        },
        id: 1,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS', // by spec SYN_REPLY
        writable: true
      })
    })

    await t.step('should parse frame with FIN_FLAG', async () => {
      var hexFrame = '80030002010000140000000178f9e3c6a7c202a6230600000000ffff'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        fin: true,
        headers: {},
        id: 1,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS', // by spec SYN_REPLY
        writable: true
      })
    })
  })

  await t.step('DATA_FRAME', async t => {
    await t.step('should parse frame with no flags', async () => {
      var hexFrame = '000000010000001157726974696e6720746f2073747265616d'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        data: decode(new TextEncoder().encode('57726974696e6720746f2073747265616d')),
        fin: false,
        id: 1,
        type: 'DATA'
      })
    })

    await t.step('should parse partial frame with no flags', async () => {
      var hexFrame = '000000010000001157726974696e6720746f207374726561'

      const ctx = new TestContext()
      await ctx.passNext(hexFrame, {
        data: decode(new TextEncoder().encode('57726974696e6720746f207374726561')),
        fin: false,
        id: 1,
        type: 'DATA',
      });

      assertEquals(ctx.parser.waiting, 1)

      await ctx.pass('ff', {
        data: decode(new TextEncoder().encode('ff')),
        fin: false,
        id: 1,
        type: 'DATA'
      })
      assertEquals(ctx.window.recv.current, 1048559)
    })

    await t.step('should parse frame with FLAG_FIN', async () => {
      var hexFrame = '000000010100001157726974696e6720746f2073747265616d'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        data: decode(new TextEncoder().encode('57726974696e6720746f2073747265616d')),
        fin: true,
        id: 1,
        type: 'DATA'
      })
    })

    await t.step('should parse partial frame with FLAG_FIN', async () => {
      var hexFrame = '000000010100001157726974696e6720746f207374726561'

      const ctx = new TestContext()
      await ctx.passNext(hexFrame, {
        data: decode(new TextEncoder().encode('57726974696e6720746f207374726561')),
        fin: false,
        id: 1,
        type: 'DATA'
      })

      assertEquals(ctx.parser.waiting, 1)

      await ctx.pass('ff', {
        data: decode(new TextEncoder().encode('ff')),
        fin: true,
        id: 1,
        type: 'DATA'
      })
    })
  })

  await t.step('RST_STREAM', async t => {
    await t.step('should parse w/ status code PROTOCOL_ERROR', async () => {
      var hexFrame = '80030003000000080000000100000001'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'PROTOCOL_ERROR',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code INVALID_STREAM', async () => {
      var hexFrame = '80030003000000080000000100000002'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'INVALID_STREAM',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code REFUSED_STREAN', async () => {
      var hexFrame = '80030003000000080000000100000003'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'REFUSED_STREAM',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code UNSUPPORTED_VERSION', async () => {
      var hexFrame = '80030003000000080000000100000004'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'UNSUPPORTED_VERSION',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code CANCEL', async () => {
      var hexFrame = '80030003000000080000000100000005'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'CANCEL',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code INTERNAL_ERROR', async () => {
      var hexFrame = '80030003000000080000000100000006'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'INTERNAL_ERROR',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code FLOW_CONTROL_ERROR', async () => {
      var hexFrame = '80030003000000080000000100000007'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'FLOW_CONTROL_ERROR',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code STREAM_IN_USE', async () => {
      var hexFrame = '80030003000000080000000100000008'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'STREAM_IN_USE',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code STREAM_ALREADY_CLOSED', async () => {
      var hexFrame = '80030003000000080000000100000009'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        code: 'STREAM_CLOSED', // STREAM_ALREADY_CLOSED by spec
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })

    await t.step('should parse w/ status code FRAME_TOO_LARGE', async () => {
      var hexframe = '8003000300000008000000010000000b'

      const ctx = new TestContext()
      await ctx.pass(hexframe, {
        code: 'FRAME_TOO_LARGE',
        id: 1,
        type: 'RST' // RST_STREAM by spec
      })
    })
  })

  await t.step('SETTINGS', async t => {
    await t.step('should parse frame', async () => {
      var hexFrame = '800300040000000c000000010100000700000100'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        settings: {
          initial_window_size: 256
        },
        type: 'SETTINGS'
      })
    })
  })

  await t.step('PING', async t => {
    await t.step('should parse ACK frame', async () => {
      var hexFrame = '800300060000000400000001'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        ack: true,
        opaque: decode(new TextEncoder().encode('00000001')),
        type: 'PING'
      })
    })
  })

  await t.step('PING', async t => {
    await t.step('should parse not ACK frame', async () => {
      var hexFrame = '800300060000000400000002'

      const ctx = new TestContext()
      await ctx.pass(hexFrame, {
        ack: false,
        opaque: decode(new TextEncoder().encode('00000002')),
        type: 'PING'
      })
    })
  })

  await t.step('GOAWAY', async t => {
    await t.step('should parse frame with status code OK', async () => {
      var hexframe = '80030007000000080000000100000000'

      const ctx = new TestContext()
      await ctx.pass(hexframe, {
        code: 'OK',
        lastId: 1,
        type: 'GOAWAY'
      })
    })

    await t.step('should parse frame with status code PROTOCOL_ERROR', async () => {
      var hexframe = '80030007000000080000000100000001'

      const ctx = new TestContext()
      await ctx.pass(hexframe, {
        code: 'PROTOCOL_ERROR',
        lastId: 1,
        type: 'GOAWAY'
      })
    })

    await t.step('should parse frame with status code INTERNAL_ERROR', async () => {
      var hexframe = '80030007000000080000000100000002'

      const ctx = new TestContext()
      await ctx.pass(hexframe, {
        code: 'INTERNAL_ERROR',
        lastId: 1,
        type: 'GOAWAY'
      })
    })
  })

  await t.step('HEADERS', async t => {
    await t.step('should parse frame', async () => {
      var context = '8003000200000057000000013830e3c6a7c2004300bcff00000003' +
                '000000057468657265000000057468657265000000073a737461747573' +
                '00000006323030204f4b000000083a76657273696f6e00000008485454' +
                     '502f312e31000000ffff'

      var frame = '800300080000002500000001001700e8ff00000001000000046d6f7265' +
                     '0000000768656164657273000000ffff'

      const ctx = new TestContext()
      await ctx.passNext(context, {
        fin: false,
        headers: {
          ':status': '200',
          there: 'there'
        },
        id: 1,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS',
        writable: true
      })
      await ctx.pass(frame, {
        fin: false,
        headers: {
          more: 'headers'
        },
        id: 1,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS',
        writable: true
      })
    })

    await t.step('should parse two consecutive frames', async () => {
      var data = '8003000800000022000000043830e3c6a7c2000e00f1ff00' +
                 '00000100000001610000000162000000ffff800300080000' +
                 '001c00000004000e00f1ff00000001000000016100000001' +
                 '62000000ffff'

      const ctx = new TestContext()
      await ctx.pass(data, [ {
        fin: false,
        headers: {
          a: 'b'
        },
        id: 4,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS',
        writable: true
      }, {
        fin: false,
        headers: {
          a: 'b'
        },
        id: 4,
        path: undefined,
        priority: {
          exclusive: false,
          parent: 0,
          weight: 16
        },
        type: 'HEADERS',
        writable: true
      } ])
    })
  })

  await t.step('WINDOW_UPDATE', async t => {
    await t.step('should parse frame', async () => {
      var hexframe = '8003000900000008000000010000abca'

      const ctx = new TestContext()
      await ctx.pass(hexframe, {
        delta: 43978,
        id: 1,
        type: 'WINDOW_UPDATE'
      })
    })
  })
})
