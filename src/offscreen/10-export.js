"use strict";

function buildHar(requests, responses, bodies) {
  var maps = responseMaps(responses, bodies);
  return {
    log: {
      version: "1.2",
      creator: { name: "WebCaptrue", version: EXTENSION_VERSION },
      entries: requests.map(function (r) {
        var q = r.data;
        var s = maps.responseByKey[recordKey(q)] || {};
        var b = maps.bodyByKey[recordKey(q)];
        var content = { size: b ? String(b.body || "").length : -1, mimeType: s.mimeType || "" };
        if (b && !b.base64Encoded && String(b.body || "").length <= 262144) content.text = b.body;
        var queryString = [];
        try {
          var parsedUrl = new URL(q.url || "");
          parsedUrl.searchParams.forEach(function (value, name) { queryString.push({ name: name, value: value }); });
        } catch (_) {}
        return {
          startedDateTime: r.capturedAt,
          time: 0,
          request: {
            method: q.method || "GET",
            url: q.url || "",
            httpVersion: "",
            headers: Object.keys(q.headers || {}).map(function (name) { return { name: name, value: String(q.headers[name]) }; }),
            queryString: queryString,
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
          _requestKey: q.requestKey,
          _resourceType: q.resourceType,
          _target: q.target,
          _interaction: q.interaction
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
  var interactions = byType.interaction || [];
  var apiIndex = buildApiIndex(requests, responses, bodies);
  var workflow = buildWorkflow(interactions, requests, responses);
  var summary = buildSummary(meta, records, apiIndex, workflow);
  var files = [];

  files.push(textFile("manifest.json", {
    format: "webcaptrue-capture",
    formatVersion: 2,
    extensionVersion: EXTENSION_VERSION,
    minimumChromeVersion: 109,
    exportedAt: new Date().toISOString(),
    session: meta
  }));
  files.push(textFile("README.txt",
    "WebCaptrue offline capture\n\n" +
    "Start AI analysis with ai/summary.json, ai/workflow.json and api/api-index.json.\n" +
    "This archive may contain internal URLs, request/response bodies and business data.\n" +
    "Cookie, Authorization and Set-Cookie headers are redacted by default.\n" +
    "Use only where you are authorized to inspect the captured system.\n"
  ));
  files.push(textFile("ai/summary.json", summary));
  files.push(textFile("ai/workflow.json", workflow));
  files.push(textFile("ai/analysis-guide.md",
    "# WebCaptrue analysis entrypoint\n\n" +
    "1. Read `summary.json` for scope and counts.\n" +
    "2. Read `workflow.json` to map user actions to API calls.\n" +
    "3. Read `../api/api-index.json` for normalized endpoints and inferred schemas.\n" +
    "4. Use `../network/session.har` and request/response JSONL for exact traffic.\n" +
    "5. Use `../runtime/scripts/`, `../dom/`, and `../storage/` to trace implementation details.\n"
  ));
  files.push(textFile("timeline.jsonl", records.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n"));
  files.push(textFile("network/requests.jsonl", jsonl(requests)));
  files.push(textFile("network/responses.jsonl", jsonl(responses)));
  files.push(textFile("network/response-bodies.jsonl", jsonl(bodies)));
  files.push(textFile("network/session.har", buildHar(requests, responses, bodies)));
  files.push(textFile("api/api-index.json", apiIndex));
  files.push(textFile("interactions/actions.jsonl", jsonl(interactions)));
  files.push(textFile("runtime/console.jsonl", jsonl((byType.console || []).concat(byType.log || []))));
  files.push(textFile("runtime/exceptions.jsonl", jsonl(byType.exception || [])));
  files.push(textFile("runtime/targets.jsonl", jsonl((byType.targetAttached || []).concat(byType.targetAttachFailed || []).concat(byType.targetDetached || []).concat(byType.targetDestroyed || []))));
  files.push(textFile("network/websocket.jsonl", jsonl(byType.webSocket || [])));
  files.push(textFile("network/eventsource.jsonl", jsonl(byType.eventSource || [])));

  (byType.domSnapshot || []).forEach(function (r, index) {
    files.push(textFile("dom/" + String(index + 1).padStart(3, "0") + "-" + safeName(r.data.label) + ".html", r.data.html || ""));
  });
  (byType.domStructuredSnapshot || []).forEach(function (r, index) {
    files.push(textFile("dom/structured-" + String(index + 1).padStart(3, "0") + "-" + safeName(r.data.label) + ".json", r.data.snapshot || {}));
  });
  (byType.clientStorageSnapshot || []).forEach(function (r, index) {
    var origin = r.data.snapshot && r.data.snapshot.origin || "unknown-origin";
    var frameId = r.data.frameId === undefined ? "unknown" : r.data.frameId;
    files.push(textFile("storage/client/" + String(index + 1).padStart(3, "0") + "-frame-" + frameId + "-" + safeName(origin).replace(/\//g, "_") + "-" + safeName(r.data.label) + ".json", r.data));
  });
  (byType.screenshot || []).forEach(function (r, index) {
    var encoded = String(r.data.dataUrl || "").split(",")[1] || "";
    files.push({ path: "screenshots/" + String(index + 1).padStart(3, "0") + "-" + safeName(r.data.mode || "shot") + "-" + safeName(r.data.label) + ".png", data: base64ToBytes(encoded) });
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
    var targetSuffix = d.target && d.target.type ? "-" + safeName(d.target.type) : "";
    var name = d.url ? safeName(d.url).replace(/\//g, "_") : ("anonymous-" + String(index + 1).padStart(4, "0") + ".js");
    if (!/\.js$/i.test(name)) name += ".js";
    files.push(textFile("runtime/scripts/" + String(index + 1).padStart(5, "0") + targetSuffix + "-" + name, d.source || ""));
  });

  files.push(textFile("ai/capture-index.json", {
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    logicalCounts: summary.counts,
    exportedFileCountBeforeIndex: files.length,
    directories: ["ai", "api", "network", "interactions", "runtime", "dom", "storage", "screenshots", "resources"]
  }));

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
