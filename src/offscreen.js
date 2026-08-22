(function () {
  "use strict";

  var db = new WebCaptrueDB();
  var blobUrls = new Set();

  setInterval(function () {
    chrome.runtime.sendMessage({ type: "KEEPALIVE" }, function () { void chrome.runtime.lastError; });
  }, 20000);

  function textFile(path, value) {
    return { path: path, data: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
  }

  function jsonl(records) {
    return records.map(function (r) { return JSON.stringify(r.data); }).join("\n") + (records.length ? "\n" : "");
  }

  function base64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function safeName(value) {
    return String(value || "resource")
      .replace(/^https?:\/\//i, "")
      .replace(/[?#].*$/, "")
      .replace(/[^a-zA-Z0-9._/-]+/g, "_")
      .replace(/\/+$/, "")
      .slice(0, 180) || "resource";
  }

  function extensionFor(mime) {
    var m = String(mime || "").toLowerCase();
    if (m.indexOf("json") >= 0) return ".json";
    if (m.indexOf("javascript") >= 0) return ".js";
    if (m.indexOf("text/css") >= 0) return ".css";
    if (m.indexOf("text/html") >= 0) return ".html";
    if (m.indexOf("image/png") >= 0) return ".png";
    if (m.indexOf("image/jpeg") >= 0) return ".jpg";
    if (m.indexOf("image/webp") >= 0) return ".webp";
    if (m.indexOf("image/svg") >= 0) return ".svg";
    if (m.indexOf("font/woff2") >= 0) return ".woff2";
    if (m.indexOf("font/woff") >= 0) return ".woff";
    if (m.indexOf("wasm") >= 0) return ".wasm";
    if (m.indexOf("xml") >= 0) return ".xml";
    if (m.indexOf("text/") === 0) return ".txt";
    return ".bin";
  }

  function buildApiIndex(requests, responses) {
    var responseById = {};
    responses.forEach(function (r) { responseById[r.data.requestId] = r.data; });
    var grouped = {};
    requests.forEach(function (r) {
      var d = r.data;
      if (d.resourceType !== "XHR" && d.resourceType !== "Fetch") return;
      var key = d.method + " " + d.url;
      if (!grouped[key]) grouped[key] = {
        method: d.method,
        url: d.url,
        resourceType: d.resourceType,
        calls: 0,
        statuses: [],
        initiators: []
      };
      var g = grouped[key];
      g.calls += 1;
      var res = responseById[d.requestId];
      if (res && g.statuses.indexOf(res.status) < 0) g.statuses.push(res.status);
      if (d.initiator && d.initiator.type && g.initiators.indexOf(d.initiator.type) < 0) g.initiators.push(d.initiator.type);
    });
    return Object.keys(grouped).map(function (k) { return grouped[k]; });
  }

  function buildHar(requests, responses, bodies) {
    var responseById = {};
    var bodyById = {};
    responses.forEach(function (r) { responseById[r.data.requestId] = r.data; });
    bodies.forEach(function (r) { bodyById[r.data.requestId] = r.data; });

    return {
      log: {
        version: "1.2",
        creator: { name: "WebCaptrue", version: "0.1.0" },
        entries: requests.map(function (r) {
          var q = r.data;
          var s = responseById[q.requestId] || {};
          var b = bodyById[q.requestId];
          var content = { size: b ? String(b.body || "").length : -1, mimeType: s.mimeType || "" };
          if (b && !b.base64Encoded && String(b.body || "").length <= 262144) content.text = b.body;
          return {
            startedDateTime: r.capturedAt,
            time: 0,
            request: {
              method: q.method || "GET",
              url: q.url || "",
              httpVersion: "",
              headers: Object.keys(q.headers || {}).map(function (name) { return { name: name, value: String(q.headers[name]) }; }),
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: q.postData ? q.postData.length : 0,
              postData: q.postData ? { mimeType: (q.headers && (q.headers["Content-Type"] || q.headers["content-type"])) || "", text: q.postData } : undefined
            },
            response: {
              status: s.status || 0,
              statusText: s.statusText || "",
              httpVersion: s.protocol || "",
              headers: Object.keys(s.headers || {}).map(function (name) { return { name: name, value: String(s.headers[name]) }; }),
              cookies: [],
              content: content,
              redirectURL: "",
              headersSize: -1,
              bodySize: b ? String(b.body || "").length : -1
            },
            cache: {},
            timings: { send: -1, wait: -1, receive: -1 },
            _requestId: q.requestId,
            _resourceType: q.resourceType
          };
        })
      }
    };
  }

  async function exportSession(sessionId, meta) {
    var records = await db.getSessionRecords(sessionId);
    var byType = {};
    records.forEach(function (r) {
      if (!byType[r.type]) byType[r.type] = [];
      byType[r.type].push(r);
    });
    var requests = byType.request || [];
    var responses = byType.response || [];
    var bodies = byType.responseBody || [];
    var files = [];

    files.push(textFile("manifest.json", {
      format: "webcaptrue-capture",
      formatVersion: 1,
      extensionVersion: "0.1.0",
      minimumChromeVersion: 109,
      exportedAt: new Date().toISOString(),
      session: meta
    }));
    files.push(textFile("README.txt",
      "WebCaptrue offline capture\n\n" +
      "This archive may contain internal URLs, request/response bodies and business data.\n" +
      "Cookie, Authorization and Set-Cookie headers are redacted by default.\n" +
      "Use only where you are authorized to inspect the captured system.\n"
    ));
    files.push(textFile("timeline.jsonl", records.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n"));
    files.push(textFile("network/requests.jsonl", jsonl(requests)));
    files.push(textFile("network/responses.jsonl", jsonl(responses)));
    files.push(textFile("network/session.har", buildHar(requests, responses, bodies)));
    files.push(textFile("api/api-index.json", buildApiIndex(requests, responses)));
    files.push(textFile("interactions/actions.jsonl", jsonl(byType.interaction || [])));
    files.push(textFile("runtime/console.jsonl", jsonl((byType.console || []).concat(byType.log || []))));
    files.push(textFile("runtime/exceptions.jsonl", jsonl(byType.exception || [])));
    files.push(textFile("network/websocket.jsonl", jsonl(byType.webSocket || [])));
    files.push(textFile("network/eventsource.jsonl", jsonl(byType.eventSource || [])));

    (byType.domSnapshot || []).forEach(function (r, index) {
      files.push(textFile("dom/" + String(index + 1).padStart(3, "0") + "-" + safeName(r.data.label) + ".html", r.data.html || ""));
    });
    (byType.storageSnapshot || []).forEach(function (r, index) {
      files.push(textFile("storage/" + String(index + 1).padStart(3, "0") + "-" + safeName(r.data.label) + ".json", r.data.value || {}));
    });
    (byType.screenshot || []).forEach(function (r, index) {
      var encoded = String(r.data.dataUrl || "").split(",")[1] || "";
      files.push({ path: "screenshots/" + String(index + 1).padStart(3, "0") + "-" + safeName(r.data.label) + ".png", data: base64ToBytes(encoded) });
    });
    var preloaded = byType.preloadedResource || [];
    var scriptSources = byType.scriptSource || [];

    bodies.forEach(function (r, index) {
      var d = r.data;
      var guessed = safeName(d.url).replace(/\/$/, "") || ("resource-" + index);
      if (!/\.[a-zA-Z0-9]{1,8}$/.test(guessed)) guessed += extensionFor(d.mimeType);
      var path = "resources/" + String(index + 1).padStart(5, "0") + "-" + guessed.replace(/\//g, "_");
      files.push({ path: path, data: d.base64Encoded ? base64ToBytes(d.body || "") : String(d.body || "") });
    });
    preloaded.forEach(function (r, index) {
      var d = r.data;
      var guessed = safeName(d.url).replace(/\/$/, "") || ("preloaded-" + index);
      if (!/\.[a-zA-Z0-9]{1,8}$/.test(guessed)) guessed += extensionFor(d.mimeType);
      files.push({
        path: "resources/preloaded/" + String(index + 1).padStart(5, "0") + "-" + guessed.replace(/\//g, "_"),
        data: d.base64Encoded ? base64ToBytes(d.body || "") : String(d.body || "")
      });
    });
    scriptSources.forEach(function (r, index) {
      var d = r.data;
      var name = d.url ? safeName(d.url).replace(/\//g, "_") : ("anonymous-" + String(index + 1).padStart(4, "0") + ".js");
      if (!/\.js$/i.test(name)) name += ".js";
      files.push(textFile("runtime/scripts/" + String(index + 1).padStart(5, "0") + "-" + name, d.source || ""));
    });

    var blob = WebCaptrueZip.createZip(files);
    var url = URL.createObjectURL(blob);
    blobUrls.add(url);
    return { blobUrl: url, fileCount: files.length, size: blob.size };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type || message.target !== "offscreen") return false;
    if (message.type === "EXPORT_SESSION") {
      exportSession(message.sessionId, message.meta).then(function (result) {
        sendResponse({ ok: true, blobUrl: result.blobUrl, fileCount: result.fileCount, size: result.size });
      }).catch(function (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
      return true;
    }
    if (message.type === "REVOKE_BLOB" && message.blobUrl) {
      try { URL.revokeObjectURL(message.blobUrl); } catch (_) {}
      blobUrls.delete(message.blobUrl);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}());
