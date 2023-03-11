#!/usr/bin/env -S deno run --unstable --allow-env --allow-read --allow-net
import { KubeConfig } from "https://deno.land/x/kubernetes_client@v0.5.0/lib/kubeconfig.ts";
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
  command: ['cat'],//, 'echo hii; cat; exit'],
  stdin: true,
  stdout: true,
  stderr: true,
  tty: false,
});

// Hook up streams to the TTY
await Promise.all([
  tunnel.stdout.pipeTo(Deno.stdout.writable, { preventClose: true }),
  tunnel.stderr.pipeTo(Deno.stderr.writable, { preventClose: true }),
  Deno.stdin.readable.pipeTo(tunnel.stdin),
]);
console.error(await tunnel.status);

tunnel.spdyTunnel.end();
