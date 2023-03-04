// Exports utils
export * as utils from './spdy-transport/utils.ts'

// Export parser&framer
import * as base from './spdy-transport/protocol/base/index.ts'
import * as spdy from './spdy-transport/protocol/spdy/index.ts'
// export * as http2 from './spdy-transport/protocol/http2/index.js'
export const protocol = {
  base,
  spdy,
  // http2,
}

// Window
export { Window } from './spdy-transport/window.ts'

// Priority Tree
export { PriorityNode, PriorityTree } from './spdy-transport/priority.ts'

// Export Connection and Stream
export { Stream } from './spdy-transport/stream.ts';
export { Connection, Connection as connection } from './spdy-transport/connection.ts';

// Just for `connection.create()`
// export const connection = transport.Connection
