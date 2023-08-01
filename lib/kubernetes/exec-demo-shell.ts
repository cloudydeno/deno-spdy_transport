#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net

import { KubeConfig } from "https://deno.land/x/kubernetes_client@v0.5.2/lib/kubeconfig.ts";
import { merge } from "https://deno.land/x/stream_observables@v1.3/combiners/merge.ts"
import { bytesAsHex } from "../spdy-transport/utils.ts";
import { execUsing } from "./exec.ts";
import { KubeConfigSpdyTunnelClient } from "./tunnel-client.ts";

// Load Kubernetes client configuration (auth, etc)
const kubeConfig = await KubeConfig.getDefaultConfig();

// Construct a TCP/TLS client for the Kubernetes APIServer
const client = await KubeConfigSpdyTunnelClient.forKubeConfig(kubeConfig);

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await execUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-7d999dfcf5-6bhdg',
  container: 'nginx',
  command: ['sh', '-i'],//, 'echo hii; cat; exit'],
  stdin: true,
  stdout: true,
  stderr: true,
  tty: true,
});

const promises: Promise<unknown>[] = [tunnel.status];

if (tunnel.stdout) {
  promises.push(tunnel.stdout.pipeTo(Deno.stdout.writable));
}
if (tunnel.stderr) {
  promises.push(tunnel.stderr.pipeTo(Deno.stderr.writable));
}

if (tunnel.resize) { // We want to hook up the raw TTY
  Deno.stdin.setRaw(true, { cbreak: true });
  const termSize = Deno.consoleSize()
  tunnel.resize.getWriter().write(new TextEncoder().encode(JSON.stringify({Width: termSize.columns, Height: termSize.rows})));

  const interruptBuffer = new Uint8Array([0x03]);
  const ctrlC = new TransformStream<void,Uint8Array>({
    transform: (_, ctlr) => ctlr.enqueue(interruptBuffer),
  });
  const ctrlCwriter = ctrlC.writable.getWriter();
  Deno.addSignalListener('SIGINT', () => {
    ctrlCwriter.write();
  });

  promises.push(merge(ctrlC.readable, Deno.stdin.readable).pipeTo(tunnel.stdin));
} else if (tunnel.stdin) {
  promises.push(Deno.stdin.readable.pipeTo(tunnel.stdin));
}

await Promise.all(promises);
// 000000 80 03 00 03 00 00 00 08 00 00 00 01 00 00 00 05 // ended
// 000000 80 03 00 03 00 00 00 08 00 00 00 03 00 00 00 05 // closed
console.error(await tunnel.status);

tunnel.spdyTunnel.end();

// const writer = tunnel.stdin.getWriter();
// await writer.write(new TextEncoder().encode(`echo hello`));
// await writer.close();

// for await (const chunk of tunnel.stdout) {
//   console.error(chunk);
// }
// console.error(await tunnel.status);


// export function mergeUntilFirstClose<T>(...os: Array<ReadableStream<T>>): ReadableStream<T> {
//   return new ReadableStream<T>(
//     {
//       async start(controller) {
//         const readers = os.map(x => x.getReader());
//         const forwarders = readers.map(async reader => {
//           while (true) {
//             const { value, done } = await reader.read();
//             if (done) {
//               return;
//             }
//             controller.enqueue(value!);
//           }
//         });
//         await Promise.race(forwarders);
//         controller.close();
//         for (const reader of readers) {
//           reader.cancel();
//         }
//       }
//     },
//     { highWaterMark: 0 }
//   );
// }
