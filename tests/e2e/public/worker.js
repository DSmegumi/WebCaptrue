self.onmessage = () => setTimeout(async () => {
  const response = await fetch("/api/items?from=worker");
  self.postMessage(await response.json());
}, 1000);
