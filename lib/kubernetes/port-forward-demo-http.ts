#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net

// setTimeout(Deno.exit, 5000);

import { KubeConfig } from "https://deno.land/x/kubernetes_client@v0.5.0/lib/kubeconfig.ts";
import { PortForwardTunnel } from "./port-forward.ts";
import { KubeConfigSpdyTunnelClient } from "./tunnel-client.ts";

// Load Kubernetes client configuration (auth, etc)
const kubeConfig = await KubeConfig.getDefaultConfig();

// Construct a TCP/TLS client for the Kubernetes APIServer
const client = await KubeConfigSpdyTunnelClient.forKubeConfig(kubeConfig);

// Establish tunneled SPDY connection to a particular Pod's kubelet
const tunnel = await PortForwardTunnel.connectUsing(client, {
  namespace: 'dagd',
  podName: 'dagd-app-7d999dfcf5-6bhdg',
});

async function httpInteraction(path: string) {
  const {stream, result} = await tunnel.connectToPort(80);

  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(
  `GET ${path} HTTP/1.1
Host: localhost:8000
Connection: close
Accept: */*

`.replaceAll('\n', '\r\n')))
  await writer.close()
  console.error("Wrote request")

  return await new Response(stream.readable).text();
}

const resps = await Promise.all([
  httpInteraction('/ip'),
  httpInteraction('/ip'),
  httpInteraction('/ip'),
]);
console.error(resps)

console.error('Disconnecting...');
tunnel.disconnect()
