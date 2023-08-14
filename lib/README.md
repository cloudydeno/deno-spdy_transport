# /x/spdy_transport

> SPDY/HTTP2 generic transport implementation.
> Now ported to Deno, because Kubernetes.

## Usage

```javascript
import { Connection } from "https://deno.land/x/spdy_transport/mod.ts";

// NOTE: socket is a readable/writable pair like from Deno.connectTls().

// Handshake with the server
var client = new Connection(socket, {
  protocol: 'http2',
  isServer: false,
});
client.start(4); // sends preface

// Initiate a request stream
const stream = await client.request({
  method: 'GET',
  path: '/',
  host: 'example.com',
  writable: true,
  readable: true,
});
stream.writable.close();

// Receive the response headers
const response = await new Promise(ok => {
  stream.once('response', (status, headers) => {
    ok({ status, headers });
  });
});
console.error('HTTP', response.status);

// Receive the response body
const text = await new Response(stream.readable).text();
console.log(text);
```

## LICENSE

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2015.
Copyright Daniel Lamando, 2023.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

[0]: http://json.org/
[1]: http://github.com/indutny/bud-backend
[2]: https://github.com/nodejs/io.js
[3]: https://github.com/libuv/libuv
[4]: http://openssl.org/
