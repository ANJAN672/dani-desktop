import { DEFAULT_FREE_PROXY_HOST, DEFAULT_FREE_PROXY_PORT, startFreeProxy } from "./dani-free/proxy.ts";
const requested = Number.parseInt(process.env.DANI_FREE_PORT ?? "", 10);
try {
  const proxy = await startFreeProxy({ host: process.env.DANI_FREE_HOST || DEFAULT_FREE_PROXY_HOST, port: Number.isSafeInteger(requested) && requested >= 0 ? requested : DEFAULT_FREE_PROXY_PORT });
  process.stdout.write(`${JSON.stringify({ daniFreeProxy: true, host: proxy.host, port: proxy.port, baseUrl: proxy.baseUrl })}\n`);
  const stop = async () => { await proxy.close(); process.exit(0); };
  process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
} catch (error) { process.stderr.write(`dani-free-proxy: ${String(error)}\n`); process.exit(1); }
