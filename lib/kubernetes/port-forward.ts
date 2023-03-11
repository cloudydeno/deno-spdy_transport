import { Connection, Stream } from "../spdy-transport.ts"
import { KubeConfigSpdyTunnelClient } from "./tunnel-client.ts";

export class PortForwardTunnel {
  constructor(
    private tunnel: Connection,
  ) {}
  private nextRequestId = 0;

  static async connectUsing(client: KubeConfigSpdyTunnelClient, opts: {
    namespace?: string;
    podName: string;
  }) {
    const tunnel = await client.dialSpdyTunnel({
      method: 'POST',
      path: `/api/v1/namespaces/${opts.namespace ?? client.defaultNamespace ?? 'default'}/pods/${opts.podName}/portforward`,
      streamProtocols: ['portforward.k8s.io'],
    });
    return new this(tunnel);
  }

  async connectToPort(port: number) {
    const requestID = this.nextRequestId++;
    const [errorStream, stream] = await Promise.all([
      this.tunnel.request({
        method: 'GET',
        path: '/',
        headers: {
          streamType: 'error',
          port,
          requestID,
        },
        writable: false,
        readable: true,
      }),
      this.tunnel.request({
        method: 'GET',
        path: '/',
        headers: {
          streamType: 'data',
          port,
          requestID,
        },
        readable: true,
        writable: true,
      }),
    ]);
    console.error('Got streams');

    const errorBody = new Response(errorStream.readable).text();
    errorBody.then(text => {
      console.error("Received portforward error response:", text);
    });

    return {
      result: errorBody,
      stream,
    }
  }

  servePortforward(opts: Deno.ListenOptions & {
    targetPort: number;
  }) {
    const listener = Deno.listen(opts);
    (async () => {
      for await (const conn of listener) {
        const {stream, result} = await this.connectToPort(opts.targetPort);
        console.error('Client connection opened');
        Promise.all([
          result,
          conn.readable.pipeTo(stream.writable),
          stream.readable.pipeTo(conn.writable),
        ]).then(x => {
          console.error('Client connection closed.', x[0]);
        }).catch(err => {
          console.error('Client connection crashed:', err.message);
        });
      }
    })();
    return listener;
  }

  disconnect() {
    this.tunnel.end();
  }
}
