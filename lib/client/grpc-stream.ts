#!/usr/bin/env -S deno run --unstable --allow-env --allow-net
import { Connection } from "../spdy-transport/connection.ts";
import * as base64 from "https://deno.land/std@0.177.0/encoding/base64.ts";

// e.g. https://firestore.googleapis.com/google.firestore.v1.Firestore/ListDocuments
const url = new URL(Deno.args[0]);

const socket = await Deno.connectTls({
  hostname: url.hostname,
  port: parseInt(url.port || '443'),
  alpnProtocols: ['h2'],
});

const client = new Connection({
  readable: socket.readable,
  writable: socket.writable,
}, {
  protocol: 'http2',
  isServer: false,
  acceptPush: false,
});
client.start(4); // sends preface

const searchStr = url.searchParams.toString();
const stream = await client.request({
  method: 'POST',
  path: `${url.pathname}`,
  host: url.host,
  headers: {
    'grpc-timeout': '25S',
    'content-type': 'application/grpc',
    'te': 'trailers',
    'authorization': 'Bearer '+Deno.env.get('SERVICE_ACCOUNT_JWT'),
    'grpc-accept-encoding': 'identity',
    'user-agent': 'grpc-deno/0.1.0 (+https://github.com/cloudydeno/deno-spdy_transport)',
    ...Object.fromEntries(url.searchParams), // enable x-goog-request-params
  },
  writable: true,
  readable: true,
});

const writer = stream.writable.getWriter();

// TODO: This is a pre-encoded message from elsewhere
// const reqBytes = new Uint8Array([0x0a,0x02,0x48,0x69,0x12,0x02,0x68,0x49])
const reqBytes = base64.decode(`Ci1wcm9qZWN0cy9zdGFyZHVzdC1za3ljaGF0L2RhdGFiYXNlcy8oZGVmYXVsdCkSWRpXElVwcm9qZWN0cy9zdGFyZHVzdC1za3ljaGF0L2RhdGFiYXNlcy8oZGVmYXVsdCkvZG9jdW1lbnRzL3Nlc3Npb25zLzAxM0tWS1U3eW1nZ0lpQlhWMURT`);
const dataBytes = new Uint8Array(5 + reqBytes.length);
const dataView = new DataView(dataBytes.buffer);
dataView.setUint8(0, false ? 1 : 0); // compression toggle
dataView.setUint32(1, reqBytes.length, false);
dataBytes.set(reqBytes, 5);
await writer.write(dataBytes);
// writer.close();

setTimeout(() => {
  writer.close();
}, 10000)

stream.once('headers', trailer => {
  console.error(trailer['grpc-message'])
});
const response = await new Promise(ok => {
  stream.once('response', (status, headers) => {
    ok({ status, headers });
  });
});
console.error({response})

// const text = await new Response(stream.readable).text();
for await (const chunk of stream.readable) {
  console.error('>', base64.encode(chunk));
}
console.error('done')

// stream.destroy
// client.end();
setTimeout(() => {
  console.error('local timeout')
  client.end();
  // Deno.exit()
}, 10000)
