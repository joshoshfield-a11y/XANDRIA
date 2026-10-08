import type { IncomingMessage, ServerResponse } from "node:http";

/** Read a JSON request body. Returns null when empty or unparseable. */
export async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Send a JSON response. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** 405 for wrong-method hits. */
export function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  json(res, 405, { error: "method_not_allowed" });
}

/** Env access for server-only secrets. Never log these. */
export function serverEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required server env var: ${name}`);
  }
  return v;
}
