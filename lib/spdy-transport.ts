// Exports utils
export * as utils from './spdy-transport/utils.ts'

// Export parser&framer
export { protocol } from './spdy-transport/protocol/index.ts'

// Window
export { Window } from './spdy-transport/window.ts'

// Priority Tree
export { PriorityNode, PriorityTree } from './spdy-transport/priority.ts'

// Export Connection and Stream
export { Stream } from './spdy-transport/stream.ts';
export { Connection, Connection as connection } from './spdy-transport/connection.ts';

// Just for `connection.create()`
// export const connection = transport.Connection
