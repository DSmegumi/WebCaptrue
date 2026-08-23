var EXTENSION_VERSION = "0.2.0";
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

function recordKey(data) {
  return data && (data.requestKey || data.requestId) || "";
}

function responseMaps(responses, bodies) {
  var responseByKey = {};
  var bodyByKey = {};
  responses.forEach(function (r) { responseByKey[recordKey(r.data)] = r.data; });
  bodies.forEach(function (r) { bodyByKey[recordKey(r.data)] = r.data; });
  return { responseByKey: responseByKey, bodyByKey: bodyByKey };
}

function normalizePathSegment(segment) {
  if (/^\d{2,}$/.test(segment)) return "{id}";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return "{id}";
  if (/^[0-9a-f]{16,}$/i.test(segment)) return "{id}";
  if (/^[A-Za-z0-9_-]{24,}$/.test(segment) && /\d/.test(segment)) return "{id}";
  return segment;
}

function endpointIdentity(url) {
  try {
    var u = new URL(url);
    var path = u.pathname.split("/").map(normalizePathSegment).join("/") || "/";
    var queryNames = Array.from(new Set(Array.from(u.searchParams.keys()))).sort();
    return {
      host: u.host,
      origin: u.origin,
      path: path,
      queryParameters: queryNames,
      normalizedUrl: u.origin + path + (queryNames.length ? "?" + queryNames.map(function (k) { return k + "={value}"; }).join("&") : "")
    };
  } catch (_) {
    return { host: "", origin: "", path: url || "", queryParameters: [], normalizedUrl: url || "" };
  }
}

function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function typeOfValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function mergeSchemas(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type !== b.type) {
    var types = [];
    [a.type].concat(a.anyOf || []).concat([b.type]).concat(b.anyOf || []).forEach(function (t) {
      if (t && types.indexOf(t) < 0) types.push(t);
    });
    return { type: "mixed", anyOf: types };
  }
  if (a.type === "object") {
    var props = Object.assign({}, a.properties || {});
    Object.keys(b.properties || {}).forEach(function (key) { props[key] = mergeSchemas(props[key], b.properties[key]); });
    return { type: "object", properties: props };
  }
  if (a.type === "array") return { type: "array", items: mergeSchemas(a.items, b.items) || { type: "unknown" } };
  return a;
}

function inferSchema(value, depth) {
  if (depth > 6) return { type: "unknown" };
  var type = typeOfValue(value);
  if (type === "object") {
    var props = {};
    Object.keys(value || {}).slice(0, 150).forEach(function (key) { props[key] = inferSchema(value[key], depth + 1); });
    return { type: "object", properties: props };
  }
  if (type === "array") {
    var itemSchema = null;
    (value || []).slice(0, 30).forEach(function (item) { itemSchema = mergeSchemas(itemSchema, inferSchema(item, depth + 1)); });
    return { type: "array", items: itemSchema || { type: "unknown" } };
  }
  return { type: type };
}

function graphqlInfo(request) {
  var parsed = parseJson(request.postData);
  if (!parsed || typeof parsed !== "object") return null;
  var query = typeof parsed.query === "string" ? parsed.query : "";
  var urlLooksGraphql = /graphql/i.test(String(request.url || ""));
  if (!query && !urlLooksGraphql) return null;
  var match = query.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)?/);
  return {
    operationType: match ? match[1] : "unknown",
    operationName: parsed.operationName || (match && match[2]) || "",
    hasVariables: !!parsed.variables,
    variableSchema: parsed.variables ? inferSchema(parsed.variables, 0) : null
  };
}

function initiatorSummary(initiator) {
  if (!initiator) return null;
  var result = { type: initiator.type || "" };
  var stack = initiator.stack;
  if (stack && stack.callFrames && stack.callFrames.length) {
    result.callFrames = stack.callFrames.slice(0, 8).map(function (frame) {
      return { functionName: frame.functionName || "", url: frame.url || "", lineNumber: frame.lineNumber, columnNumber: frame.columnNumber };
    });
  }
  if (initiator.url) result.url = initiator.url;
  if (typeof initiator.lineNumber === "number") result.lineNumber = initiator.lineNumber;
  return result;
}

function buildApiIndex(requests, responses, bodies) {
  var maps = responseMaps(responses, bodies);
  var grouped = {};
  requests.forEach(function (r) {
    var d = r.data;
    if (d.resourceType !== "XHR" && d.resourceType !== "Fetch") return;
    var identity = endpointIdentity(d.url);
    var graph = graphqlInfo(d);
    var key = d.method + " " + identity.normalizedUrl + (graph && graph.operationName ? " #" + graph.operationName : "");
    if (!grouped[key]) grouped[key] = {
      method: d.method,
      normalizedUrl: identity.normalizedUrl,
      origin: identity.origin,
      host: identity.host,
      path: identity.path,
      queryParameters: identity.queryParameters,
      resourceTypes: [],
      calls: 0,
      statuses: [],
      responseMimeTypes: [],
      targetTypes: [],
      interactionIds: [],
      correlationConfidence: {},
      initiators: [],
      graphql: graph,
      requestSchema: null,
      responseSchema: null
    };
    var g = grouped[key];
    g.calls += 1;
    if (g.resourceTypes.indexOf(d.resourceType) < 0) g.resourceTypes.push(d.resourceType);
    var targetType = d.target && d.target.type || "page";
    if (g.targetTypes.indexOf(targetType) < 0) g.targetTypes.push(targetType);
    var res = maps.responseByKey[recordKey(d)];
    if (res && g.statuses.indexOf(res.status) < 0) g.statuses.push(res.status);
    if (res && res.mimeType && g.responseMimeTypes.indexOf(res.mimeType) < 0) g.responseMimeTypes.push(res.mimeType);
    if (d.interaction && d.interaction.interactionId) {
      if (g.interactionIds.indexOf(d.interaction.interactionId) < 0) g.interactionIds.push(d.interaction.interactionId);
      var c = d.interaction.confidence || "unknown";
      g.correlationConfidence[c] = (g.correlationConfidence[c] || 0) + 1;
    }
    var init = initiatorSummary(d.initiator);
    if (init) {
      var sig = JSON.stringify(init);
      if (!g._initiatorSignatures) g._initiatorSignatures = {};
      if (!g._initiatorSignatures[sig] && g.initiators.length < 12) {
        g._initiatorSignatures[sig] = true;
        g.initiators.push(init);
      }
    }
    var reqJson = parseJson(d.postData);
    if (reqJson !== null) g.requestSchema = mergeSchemas(g.requestSchema, inferSchema(reqJson, 0));
    var body = maps.bodyByKey[recordKey(d)];
    if (body && !body.base64Encoded) {
      var resJson = parseJson(body.body);
      if (resJson !== null) g.responseSchema = mergeSchemas(g.responseSchema, inferSchema(resJson, 0));
    }
  });
  return Object.keys(grouped).map(function (k) {
    var item = grouped[k];
    delete item._initiatorSignatures;
    return item;
  }).sort(function (a, b) { return b.calls - a.calls || a.normalizedUrl.localeCompare(b.normalizedUrl); });
}

function buildWorkflow(interactions, requests, responses) {
  var responseByKey = {};
  responses.forEach(function (r) { responseByKey[recordKey(r.data)] = r.data; });
  var actions = {};
  interactions.forEach(function (r) {
    var data = r.data;
    if (!data.interactionId) return;
    actions[data.interactionId] = {
      interactionId: data.interactionId,
      at: data.at || r.capturedAt,
      kind: data.kind || "unknown",
      frameId: data.frameId,
      frameUrl: data.frameUrl || "",
      target: data.target || {},
      requests: []
    };
  });
  var uncorrelated = [];
  requests.forEach(function (r) {
    var q = r.data;
    if (q.resourceType !== "XHR" && q.resourceType !== "Fetch") return;
    var res = responseByKey[recordKey(q)] || {};
    var item = {
      method: q.method,
      url: q.url,
      normalizedUrl: endpointIdentity(q.url).normalizedUrl,
      status: res.status || 0,
      resourceType: q.resourceType,
      targetType: q.target && q.target.type || "page",
      delayMs: q.interaction && q.interaction.interactionDelayMs,
      confidence: q.interaction && q.interaction.confidence || "none"
    };
    var interactionId = q.interaction && q.interaction.interactionId;
    if (interactionId && actions[interactionId]) actions[interactionId].requests.push(item);
    else uncorrelated.push(item);
  });
  return {
    actions: interactions.map(function (r) { return actions[r.data.interactionId]; }).filter(Boolean),
    uncorrelatedRequests: uncorrelated
  };
}

function unique(values) {
  var out = [];
  values.forEach(function (value) { if (value !== undefined && value !== null && value !== "" && out.indexOf(value) < 0) out.push(value); });
  return out;
}

function buildCompleteness(meta, records) {
  var byType = {};
  records.forEach(function (record) {
    if (!byType[record.type]) byType[record.type] = [];
    byType[record.type].push(record);
  });
  var requests = byType.request || [];
  var responses = byType.response || [];
  var bodies = byType.responseBody || [];
  var skippedBodies = byType.responseBodySkipped || [];
  var excludedBodies = byType.responseBodyExcluded || [];
  var failedLoads = byType.loadingFailed || [];
  var responseKeys = {};
  var bodyKeys = {};
  var skippedBodyKeys = {};
  var excludedBodyKeys = {};
  var failedLoadKeys = {};
  var requestByKey = {};
  responses.forEach(function (record) { responseKeys[recordKey(record.data)] = record.data; });
  bodies.forEach(function (record) { bodyKeys[recordKey(record.data)] = true; });
  skippedBodies.forEach(function (record) { skippedBodyKeys[recordKey(record.data)] = record.data.reason || "unspecified"; });
  excludedBodies.forEach(function (record) { excludedBodyKeys[recordKey(record.data)] = record.data.reason || "unspecified"; });
  failedLoads.forEach(function (record) {
    var data = record.data || {};
    var payload = data.payload || {};
    failedLoadKeys[data.requestKey || recordKey(payload)] = true;
  });
  requests.forEach(function (record) { requestByKey[recordKey(record.data)] = record.data; });

  var requestsWithoutTerminalEvent = [];
  Object.keys(requestByKey).forEach(function (key) {
    if (!responseKeys[key] && !failedLoadKeys[key]) requestsWithoutTerminalEvent.push(key);
  });

  var responsesWithoutBodyOrReason = [];
  if (!meta || !meta.options || meta.options.captureBodies !== false) {
    Object.keys(responseKeys).forEach(function (key) {
      var response = responseKeys[key] || {};
      var request = requestByKey[key] || {};
      var streamingResponse = request.resourceType === "EventSource" || /text\/event-stream/i.test(response.mimeType || "");
      var bodyNotExpected = request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304 || streamingResponse;
      if (!bodyNotExpected && !bodyKeys[key] && !skippedBodyKeys[key] && !excludedBodyKeys[key]) responsesWithoutBodyOrReason.push(key);
    });
  }

  var completenessState = meta && meta.completeness || {};
  var failureRecords = [];
  ["targetAttachFailed", "targetAutoAttachFailed", "captureDomainEnableFailed", "contentScriptInjectionFailed", "clientStorageSnapshotSkipped", "captureError", "eventHandlingFailed"].forEach(function (type) {
    (byType[type] || []).forEach(function (record) { failureRecords.push({ type: type, capturedAt: record.capturedAt, data: record.data }); });
  });
  var truncationRecords = [];
  ["responseBodySkipped", "preloadedResourceSkipped", "scriptSourceSkipped", "fullPageScreenshotFallback"].forEach(function (type) {
    (byType[type] || []).forEach(function (record) { truncationRecords.push({ type: type, capturedAt: record.capturedAt, data: record.data }); });
  });
  var exclusionRecords = [];
  ["responseBodyExcluded", "scriptSourceExcluded"].forEach(function (type) {
    (byType[type] || []).forEach(function (record) { exclusionRecords.push({ type: type, capturedAt: record.capturedAt, data: record.data }); });
  });
  var knownGapCount = requestsWithoutTerminalEvent.length + responsesWithoutBodyOrReason.length + failureRecords.length + truncationRecords.length + (completenessState.recordWriteFailures || 0);
  return {
    format: "webcaptrue-completeness",
    version: 1,
    generatedAt: new Date().toISOString(),
    verdict: knownGapCount ? "known-gaps" : "no-known-gaps",
    assertionBoundary: "no-known-gaps means no gap was detected by these checks; it is not proof that the browser exposed every possible datum",
    network: {
      requestsObserved: requests.length,
      responsesObserved: responses.length,
      loadingFailures: failedLoads.length,
      responseBodiesCaptured: bodies.length,
      responseBodiesSkippedWithReason: skippedBodies.length,
      requestsWithoutTerminalEvent: requestsWithoutTerminalEvent,
      responsesWithoutBodyOrReason: responsesWithoutBodyOrReason
    },
    targets: {
      mode: completenessState.targetMode || "unknown",
      scans: completenessState.targetScans || 0,
      candidates: completenessState.targetCandidates || 0,
      attached: (byType.targetAttached || []).length,
      attachFailures: (byType.targetAttachFailed || []).length + (byType.targetAutoAttachFailed || []).length,
      discoveries: (byType.targetDiscovery || []).length
    },
    storage: {
      snapshots: (byType.clientStorageSnapshot || []).length,
      skippedFrames: (byType.clientStorageSnapshotSkipped || []).length
    },
    pageState: {
      htmlSnapshots: (byType.domSnapshot || []).length,
      structuredSnapshots: (byType.domStructuredSnapshot || []).length,
      screenshots: (byType.screenshot || []).length,
      screenshotFallbacks: (byType.fullPageScreenshotFallback || []).length
    },
    persistence: {
      recordWriteFailures: completenessState.recordWriteFailures || 0
    },
    failures: failureRecords,
    truncations: truncationRecords,
    exclusions: exclusionRecords,
    runtimeIssues: completenessState.issues || []
  };
}

function buildSummary(meta, records, apiIndex, workflow, completeness) {
  var byType = {};
  records.forEach(function (r) { byType[r.type] = (byType[r.type] || 0) + 1; });
  var requestRecords = records.filter(function (r) { return r.type === "request"; });
  var hosts = unique(requestRecords.map(function (r) { return endpointIdentity(r.data.url).host; })).sort();
  var targetTypes = unique(records.filter(function (r) { return r.type === "targetAttached"; }).map(function (r) { return r.data.type; })).sort();
  var graphqlOperations = apiIndex.filter(function (api) { return !!api.graphql; }).map(function (api) {
    return { normalizedUrl: api.normalizedUrl, operationType: api.graphql.operationType, operationName: api.graphql.operationName, calls: api.calls };
  });
  return {
    format: "webcaptrue-ai-summary",
    version: 1,
    extensionVersion: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    session: meta,
    counts: {
      records: records.length,
      requests: byType.request || 0,
      responses: byType.response || 0,
      responseBodies: byType.responseBody || 0,
      apiEndpoints: apiIndex.length,
      interactions: byType.interaction || 0,
      consoleAndLogs: (byType.console || 0) + (byType.log || 0),
      exceptions: byType.exception || 0,
      screenshots: byType.screenshot || 0,
      storageSnapshots: byType.clientStorageSnapshot || 0,
      attachedTargets: byType.targetAttached || 0,
      websocketEvents: byType.webSocket || 0,
      eventSourceEvents: byType.eventSource || 0
    },
    hosts: hosts,
    targetTypes: targetTypes,
    graphqlOperations: graphqlOperations,
    correlatedActions: workflow.actions.filter(function (a) { return a.requests.length > 0; }).length,
    uncorrelatedApiRequests: workflow.uncorrelatedRequests.length,
    completeness: completeness || null,
    recommendedEntryPoints: [
      "ai/summary.json",
      "integrity/completeness.json",
      "ai/workflow.json",
      "api/api-index.json",
      "network/session.har",
      "timeline.jsonl"
    ]
  };
}
