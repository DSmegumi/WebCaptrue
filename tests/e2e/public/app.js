localStorage.setItem("fixture", JSON.stringify({ value: "stored", apiKey: "fixture-key", rows: [{ id: 1, name: "kept" }] }));
sessionStorage.setItem("session", "active");

const output = document.querySelector("#output");
const worker = new Worker("/worker.js");
worker.onmessage = event => console.log("worker", event.data);
worker.postMessage("ping");

if (typeof SharedWorker === "function") {
  const shared = new SharedWorker("/shared-worker.js");
  shared.port.onmessage = event => console.log("shared-worker", event.data);
  shared.port.start();
  shared.port.postMessage("ping");
}

const events = new EventSource("/events");
events.addEventListener("ready", event => console.log("sse", event.data));
const socket = new WebSocket("ws://127.0.0.1:8765/ws");
socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "client-ready", token: "fixture-client-ws-token" })));
socket.addEventListener("message", event => console.log("websocket", event.data));

const idbRequest = indexedDB.open("webcaptrue-fixture", 1);
idbRequest.onupgradeneeded = () => idbRequest.result.createObjectStore("records", { keyPath: "id" });
idbRequest.onsuccess = () => {
  const tx = idbRequest.result.transaction("records", "readwrite");
  tx.objectStore("records").put({ id: 1, name: "kept-idb", token: "fixture-idb-token" });
};

caches.open("webcaptrue-fixture").then(cache => cache.put("/cached.json", new Response(JSON.stringify({ value: "kept-cache", apiKey: "fixture-cache-key" }), { headers: { "content-type": "application/json" } })));

document.querySelector("#load").addEventListener("click", async () => {
  const response = await fetch("/api/items?customerId=123456");
  output.textContent = JSON.stringify(await response.json());
});

document.querySelector("#submit").addEventListener("click", async () => {
  const response = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: JSON.stringify({ name: document.querySelector("#normal").value, password: document.querySelector("#password").value })
  });
  output.textContent = JSON.stringify(await response.json());
});

document.querySelector("#error").addEventListener("click", () => setTimeout(() => { throw new Error("WebCaptrue fixture exception"); }));
document.querySelector("#spa").addEventListener("click", () => history.pushState({ route: "detail" }, "", "/detail/42?mode=test"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then(registration => navigator.serviceWorker.ready.then(() => {
    const target = registration.active || registration.waiting || registration.installing;
    if (target) target.postMessage("capture-fetch");
  }));
}
