import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventHub } from "./eventHub";
import { setCorsHeaders } from "./http";

export function attachSse<T>(
  req: IncomingMessage,
  res: ServerResponse,
  hub: EventHub<T>,
  options: { eventName?: string } = {},
): void {
  setCorsHeaders(req, res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const send = (event: T) => {
    if (options.eventName) res.write(`event: ${options.eventName}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = hub.subscribe(send);
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

