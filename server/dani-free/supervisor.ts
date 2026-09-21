import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

let active: { child: ChildProcess; baseUrl: string } | null = null;
export async function ensureDaniFreeProxy(): Promise<string> {
  if (active) { try { if ((await fetch(`${active.baseUrl.replace(/\/v1$/, "")}/health`)).ok) return active.baseUrl; } catch {} active = null; }
  const entry = fileURLToPath(import.meta.url).replace(/supervisor\.ts$/, "../dani-free-proxy.ts");
  const child = spawn(process.execPath, [entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DANI_FREE_PORT: process.env.DANI_FREE_PORT ?? "0" }, stdio: ["ignore", "pipe", "pipe"] });
  const result = await new Promise<string>((resolve, reject) => { let buf = ""; const timer = setTimeout(() => reject(new Error("Dani-free proxy startup timeout")), 10000); child.stdout?.on("data", (chunk: Buffer) => { buf += chunk.toString(); for (const line of buf.split("\n")) { try { const value = JSON.parse(line) as { daniFreeProxy?: boolean; baseUrl?: string }; if (value.daniFreeProxy && value.baseUrl) { clearTimeout(timer); resolve(value.baseUrl); return; } } catch {} } }); child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Dani-free proxy exited during startup (${code})`)); }); });
  active = { child, baseUrl: result }; return result;
}
export async function stopDaniFreeProxy(): Promise<void> { if (!active) return; const child = active.child; active = null; child.kill("SIGTERM"); }
