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
  command: ['sh', '-euxc', 'echo hii; cat; exit'],
  stdin: true,
  stdout: true,
});

const writer = tunnel.stdin.getWriter();
await writer.write(new TextEncoder().encode(`echo hello`));
await writer.close();

for await (const chunk of tunnel.stdout) {
  console.error(chunk);
}
console.error(await tunnel.status);
