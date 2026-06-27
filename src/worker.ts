import { Container, getContainer } from "@cloudflare/containers";

export class LatexDoBackend extends Container {
  defaultPort = 8787;
  sleepAfter = "10m";
}

interface Env {
  ASSETS: Fetcher;
  LATEXDO_BACKEND: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const backend = getContainer(env.LATEXDO_BACKEND as never, "primary");
      return backend.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
