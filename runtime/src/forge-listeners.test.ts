import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { startForgeListeners } from "./forge-listeners.js";

test("Forge shutdown releases both ports even with active HTTP streams", { timeout: 10000 }, async (t) => {
  const handler: Parameters<typeof startForgeListeners>[0] = (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("pending stream");
  };
  const listeners = await startForgeListeners(handler, handler, 0, 0);
  t.after(() => listeners.close());
  const ports = [listeners.mcp, listeners.manager].map(server => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  });
  const responses = await Promise.all(ports.map(port => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(8000) })));
  const interruptedBodies = responses.map(response => assert.rejects(response.text()));
  await listeners.close();
  await listeners.close();
  await Promise.all(interruptedBodies);
  for (const port of ports) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
    await new Promise<void>(resolve => probe.close(() => resolve()));
  }
});
