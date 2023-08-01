import { JSONValue } from "https://deno.land/x/kubernetes_client@v0.5.2/lib/contract.ts";
import { Connection, Stream } from "../spdy-transport.ts"
import { KubeConfigSpdyTunnelClient } from "./tunnel-client.ts";
import { single } from "https://deno.land/x/stream_observables@v1.3/sinks/single.ts";

type ExecOptions = {
  namespace?: string;
  podName: string;
  container: string;
  command: string[];
  stdin?: boolean;
  stdout: boolean;
  stderr?: boolean;
  tty?: boolean;
};

type ExecStreams<T extends ExecOptions> = {
  spdyTunnel: Connection;
  status: Promise<JSONValue | null>;
  stdin: T['stdin'] extends true ? WritableStream<Uint8Array> : null;
  stdout: T['stdout'] extends true ? ReadableStream<Uint8Array> : null;
  stderr: T['stderr'] extends true ? ReadableStream<Uint8Array> : null;
  resize: T['tty'] extends true ? WritableStream<Uint8Array> : null;
}

export async function execUsing<T extends ExecOptions>(client: KubeConfigSpdyTunnelClient, opts: T): Promise<ExecStreams<T>> {
  const querystring = new URLSearchParams();
  for (const command of opts.command) {
    querystring.append('command', command);
  }
  querystring.set('container', opts.container);
  if (opts.stdin) {
    querystring.set('stdin', 'true');
  }
  querystring.set('stdout', `${opts.stdout ?? true}`);
  if (opts.stderr) {
    querystring.set('stderr', 'true');
  }
  if (opts.tty) {
    querystring.set('tty', 'true');
  }

  const tunnel = await client.dialSpdyTunnel({
    method: 'POST',
    path: `/api/v1/namespaces/${opts.namespace ?? client.defaultNamespace ?? 'default'}/pods/${opts.podName}/exec`,
    querystring,
    streamProtocols: ['v4.channel.k8s.io'],
  });

  const [errorStream, stdinStream, stdoutStream, stderrStream, resizeStream] = await Promise.all([
    tunnel.request({
      method: 'GET',
      path: '/',
      headers: {
        streamType: 'error',
      },
      readable: true,
      writable: true, // false,
    }),
    opts.stdin ? tunnel.request({
      method: 'GET',
      path: '/',
      headers: {
        streamType: 'stdin',
      },
      readable: true, // false,
      writable: true,
    }).then(x => x.writable) : null,
    opts.stdout ? tunnel.request({
      method: 'GET',
      path: '/',
      headers: {
        streamType: 'stdout',
      },
      readable: true,
      writable: true, // false,
    }).then(x => x.readable) : null,
    opts.stderr ? tunnel.request({
      method: 'GET',
      path: '/',
      headers: {
        streamType: 'stderr',
      },
      readable: true,
      writable: true, // false,
    }).then(x => x.readable) : null,
    opts.tty ? tunnel.request({
      method: 'GET',
      path: '/',
      headers: {
        streamType: 'resize',
      },
      readable: true, // false,
      writable: true,
    }).then(x => x.writable) : null,
  ]);

  return {
    spdyTunnel: tunnel,
    status: new Response(errorStream.readable).text(),
    resize: resizeStream as any,
    stdin: stdinStream as any,
    stdout: stdoutStream as any,
    stderr: stderrStream as any,
  };
}
