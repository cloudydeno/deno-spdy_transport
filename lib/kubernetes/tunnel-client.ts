import { Connection } from "../spdy-transport.ts"
import { KubeConfig, KubeConfigContext } from "https://deno.land/x/kubernetes_client@v0.5.0/lib/kubeconfig.ts";
import { JSONValue } from "https://deno.land/x/kubernetes_client@v0.5.0/lib/contract.ts";

export class KubeConfigSpdyTunnelClient {
  constructor(
    private ctx: KubeConfigContext,
    private tlsMaterial: {
      caCerts: Array<string>;
      certChain: string | null;
      privateKey: string | null;
    },
  ) {
    this.defaultNamespace = ctx.defaultNamespace || 'default';
  }
  defaultNamespace?: string;

  // TODO: this logic is duplicated from
  // https://github.com/cloudydeno/deno-kubernetes_client/blob/main/transports/via-kubeconfig.ts
  static async forKubeConfig(
    config: KubeConfig,
    contextName?: string,
  ) {
    const ctx = config.fetchContext(contextName);

    let userCert = atob(ctx.user["client-certificate-data"] ?? '') || null;
    if (!userCert && ctx.user["client-certificate"]) {
      userCert = await Deno.readTextFile(ctx.user["client-certificate"]);
    }

    let userKey = atob(ctx.user["client-key-data"] ?? '') || null;
    if (!userKey && ctx.user["client-key"]) {
      userKey = await Deno.readTextFile(ctx.user["client-key"]);
    }

    if ((userKey && !userCert) || (!userKey && userCert)) throw new Error(
      `Within the KubeConfig, client key and certificate must both be provided if either is provided.`);

    let serverCert = atob(ctx.cluster["certificate-authority-data"] ?? '') || null;
    if (!serverCert && ctx.cluster["certificate-authority"]) {
      serverCert = await Deno.readTextFile(ctx.cluster["certificate-authority"]);
    }

    return new KubeConfigSpdyTunnelClient(ctx, {
      caCerts: serverCert ? [serverCert] : [],
      certChain: userCert,
      privateKey: userKey,
    });
  }

  async connectTls() {
    if (!this.ctx.cluster.server) throw new Error(`No server URL found in KubeConfig`);
    const url = new URL(this.ctx.cluster.server);

    // Deno cannot access bare IP addresses over HTTPS. See deno#7660
    // Workaround: separate TCP from TLS when calling Deno APIs
    if (url.hostname.match(/(\]|\.\d+)$/)) {
      // This workaround has its own limitation.
      if (this.tlsMaterial.privateKey) throw new Error(
        `Deno cannot use client certificates when connecting to an IP address.`);

      const plaintext = await Deno.connect({
        transport: 'tcp',
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : 443,
      });

      return await Deno.startTls(plaintext, {
        ...this.tlsMaterial,
        hostname: 'kubernetes.default.svc',
        //@ts-expect-error: Unstable parameter.
        alpnProtocols: ['http/1.1'],
      });
    }

    return await Deno.connectTls({
      ...this.tlsMaterial,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : 443,
      //@ts-expect-error: Unstable parameter.
      alpnProtocols: ['http/1.1'],
    });
  }

  async dialSpdyTunnel(opts: {
    method: 'POST';
    path: string;
    streamProtocols: Array<string>;
    querystring?: URLSearchParams;
    abortSignal?: AbortSignal;
  }) {
    let path = opts.path || '/';
    if (opts.querystring) {
      path += `?${opts.querystring}`;
    }

    // Prepare upgrade headers
    const headers = new Headers([
      ["Host", "kubernetes.default.svc"],
      ["User-Agent", `Deno/${Deno.version}`],
      ["Content-Length", "0"],
      ["Connection", "Upgrade"],
      ["Upgrade", "SPDY/3.1"],
    ]);
    for (const protocol of opts.streamProtocols) {
      headers.append("X-Stream-Protocol-Version", protocol);
    }
    const authHeader = await this.ctx.getAuthHeader();
    if (authHeader) {
      headers.set("Authorization", authHeader);
    }

    // Actually connect to the apiserver
    const socket = await this.connectTls();

    // Write the upgrade request
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode([
      `${opts.method} ${path} HTTP/1.1`,
      ...(Array.from(headers).map(x => `${x[0]}: ${x[1]}`)),
      '\r\n',
    ].join('\r\n')));
    writer.releaseLock();

    // grab the upgrade response header
    // TODO: we should really parse the HTTP message properly...
    const reader = socket.readable.getReader();
    const buff = await reader.read();
    reader.releaseLock();
    const respText = new TextDecoder().decode(buff.value);
    if (!respText.startsWith('HTTP/1.1 101 ')) {
      socket.close();
      const status = parseInt(respText.split(' ')[1]);
      const bodyJson = JSON.parse(respText.split('\r\n\r\n')[1]);
      const error: HttpError = new Error(`Kubernetes returned HTTP ${status} ${bodyJson.reason}: ${bodyJson.message}`);
      error.httpCode = status;
      error.status = bodyJson;
      throw error;
    }
    // HTTP/1.1 101 Switching Protocols
    // Connection: Upgrade
    // Upgrade: SPDY/1.3
    // X-Stream-Protocol-Version: portforward.k8s.io
    // Date: ...

    const client = new Connection({
      readable: socket.readable,
      writable: socket.writable,
    }, {
      protocol: 'spdy',
      isServer: false,
      headerCompression: true,
    });

    client.start(3.1);

    return client;
  }
}

type HttpError = Error & {
  httpCode?: number;
  status?: JSONValue;
}
