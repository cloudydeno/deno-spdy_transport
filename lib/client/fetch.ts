#!/usr/bin/env -S deno run --unstable --allow-net
import { Connection } from "../spdy-transport/connection.ts";

const url = new URL(Deno.args[0]);

const socket = await Deno.connectTls({
  hostname: url.hostname,
  port: parseInt(url.port || '443'),
  alpnProtocols: ['h2'],
});

const client = new Connection(socket, {
  protocol: 'http2',
  isServer: false,
});
client.start(4); // sends preface

const searchStr = url.searchParams.toString();
const stream = await client.request({
  method: 'GET',
  path: `${url.pathname}${searchStr ? `?${searchStr}` : ''}`,
  host: url.host,
  headers: {
    'user-agent': 'test dan',
  },
  writable: true,
  readable: true,
});
stream.writable.close();

const response = await new Promise(ok => {
  stream.once('response', (status, headers) => {
    ok({ status, headers });
  });
});
console.error({response})

const text = await new Response(stream.readable).text();
console.error('>', text);
console.error('done')

// stream.destroy
// client.end();
Deno.exit();
