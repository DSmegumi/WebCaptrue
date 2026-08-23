self.onconnect = event => {
  const port = event.ports[0];
  port.onmessage = () => setTimeout(async () => {
    const response = await fetch("/api/items?from=shared-worker");
    port.postMessage(await response.json());
  }, 1200);
  port.start();
};
