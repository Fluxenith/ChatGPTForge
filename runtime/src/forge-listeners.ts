import { createServer, type RequestListener, type Server } from "node:http";

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onReady);
      reject(error);
    };
    const onReady = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onReady);
    server.listen(port, "127.0.0.1");
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

/** Publish both loopback endpoints together, or release every listener we own. */
export async function startForgeListeners(mcpApp: RequestListener, managerApp: RequestListener, mcpPort: number, managerPort: number) {
  const mcp = createServer(mcpApp);
  const manager = createServer(managerApp);
  let closePromise: Promise<void> | undefined;
  const closeOwned = () => closePromise ??= Promise.all([close(mcp), close(manager)]).then(() => {});
  try {
    // A failed manager bind must never leave a usable MCP coordinator behind.
    await listen(manager, managerPort);
    await listen(mcp, mcpPort);
    return { mcp, manager, close: closeOwned };
  } catch (error) {
    await closeOwned();
    throw error;
  }
}
