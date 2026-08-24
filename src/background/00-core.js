"use strict";

var PROTOCOL_VERSION = "1.3";
var MAX_BODY_BYTES = 5 * 1024 * 1024;
var MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
var MAX_DIAGNOSTIC_LOG_ENTRIES = 2000;
var MAX_DIAGNOSTIC_LOG_BYTES = 2 * 1024 * 1024;
var MAX_DIAGNOSTIC_DETAIL_BYTES = 16 * 1024;
var CORRELATION_WINDOW_MS = 10000;
var STATE_KEY = "webcaptrueRuntimeState";
var SETTINGS_KEY = "webcatrueSettings";
var db = new WebCaptrueDB();
var requestMap = new Map();
var requestGenerations = new Map();
var requestHopKeys = new Map();
var requestExtraBuffers = new Map();
var responseExtraExpectedKeys = new Map();
var responseExtraBuffers = new Map();
var extraInfoAssociationIssues = new Set();
var capturedTargets = new Map();
var capturedSessions = new Map();
var targetInfoMap = new Map();
var rootFrameIds = new Set();
var allowedTargetOrigins = new Set();
var allowedTargetUrls = new Set();
var ambiguousTargetOrigins = new Set();
var reportedAmbiguousTargetOrigins = new Set();
var reportedUnattributedTargetIds = new Set();
var expectedDetachKeys = new Set();
var rootTargetId = null;
var flatSessionsSupported = false;
var targetPollTimer = null;
var targetPollRunning = false;
var legacySeenTargetIds = new Set();
var lastInteraction = null;
var lastScreenshotAt = 0;
var persistTimer = null;
var pendingDebuggerEvents = new Set();
var pendingRecordWrites = new Set();
var debuggerEventQueues = new Map();
var lastDebuggerEventAt = 0;
var lastTargetScopeRefreshAt = 0;
var targetDiscoveryFailureCodes = new Set();
var interruptedExportPromise = null;

var state = freshState();

function freshCounters() {
  return { requests: 0, responses: 0, apis: 0, actions: 0, console: 0, screenshots: 0, targets: 0, storageSnapshots: 0 };
}

function freshState() {
  return {
    active: false,
    stopping: false,
    recoverable: false,
    sessionId: null,
    tabId: null,
    startedAt: null,
    url: null,
    title: null,
    environment: null,
    options: { captureBodies: true, autoScreenshots: true, captureClientStorage: true },
    counters: freshCounters(),
    completeness: {
      targetMode: "uninitialized",
      targetScans: 0,
      targetCandidates: 0,
      targetAttachFailures: 0,
      recordWriteFailures: 0,
      issues: []
    },
    diagnostics: { recorded: 0, bytes: 0, dropped: 0, truncatedDetails: 0, truncationReported: false },
    lastError: null
  };
}

function cloneState() {
  return JSON.parse(JSON.stringify(state));
}

function chromeStorageGet(keys) {
  return new Promise(function (resolve) { chrome.storage.local.get(keys, resolve); });
}

function debuggerAttach(debuggee) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.attach(debuggee, PROTOCOL_VERSION, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function debuggerDetach(debuggee) {
  return new Promise(function (resolve) {
    chrome.debugger.detach(debuggee, function () { void chrome.runtime.lastError; resolve(); });
  });
}

function debuggerGetTargets() {
  return new Promise(function (resolve, reject) {
    chrome.debugger.getTargets(function (targets) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(targets || []);
    });
  });
}

function command(debuggee, method, params) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.sendCommand(debuggee, method, params || {}, function (result) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result || {});
    });
  });
}

async function tryCommand(debuggee, method, params) {
  try { return await command(debuggee, method, params || {}); } catch (_) { return null; }
}

function getTab(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab);
    });
  });
}

function getActiveTab() {
  return new Promise(function (resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

function getAllFrames(tabId) {
  return new Promise(function (resolve) {
    chrome.webNavigation.getAllFrames({ tabId: tabId }, function (frames) {
      if (chrome.runtime.lastError) resolve([]);
      else resolve(frames || []);
    });
  });
}

function sendTabMessage(tabId, message, frameId) {
  return new Promise(function (resolve) {
    var options = typeof frameId === "number" ? { frameId: frameId } : undefined;
    chrome.tabs.sendMessage(tabId, message, options, function (response) {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response || null);
    });
  });
}

function executeContentScript(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: ["src/lib/sanitize.js", "src/content.js"] }, function (results) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(results || []);
    });
  });
}

function captureVisible(windowId) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, function (dataUrl) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

function downloadUrl(url, filename) {
  return new Promise(function (resolve, reject) {
    chrome.downloads.download({ url: url, filename: filename, saveAs: false }, function (downloadId) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

function runtimeSend(message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (response) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response || response.ok === false) reject(new Error(response && response.error ? response.error : "Offscreen export failed"));
      else resolve(response);
    });
  });
}

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Keep Chrome 109 capture sessions alive and create local ZIP exports."
    });
  } catch (error) {
    if (!/single offscreen|already exists|Only a single/i.test(String(error && error.message || error))) throw error;
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(function () {
    persistTimer = null;
    var obj = {}; obj[STATE_KEY] = cloneState();
    chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; });
    chrome.runtime.sendMessage({ type: "STATE_UPDATED", state: cloneState() }, function () { void chrome.runtime.lastError; });
  }, 350);
}

function markCompletenessIssue(code, detail) {
  if (!state.completeness) state.completeness = freshState().completeness;
  var issue = { code: code, at: new Date().toISOString(), detail: detail || {} };
  state.completeness.issues.push(issue);
  if (state.completeness.issues.length > 100) state.completeness.issues.shift();
  schedulePersist();
}

function addRecord(type, data) {
  if (!state.sessionId) return Promise.resolve();
  var write = db.add({
    sessionId: state.sessionId,
    type: type,
    capturedAt: new Date().toISOString(),
    data: data
  }).catch(function (error) {
    if (!state.completeness) state.completeness = freshState().completeness;
    state.completeness.recordWriteFailures += 1;
    markCompletenessIssue("record-write-failed", { type: type, reason: error && error.message || String(error) });
  }).finally(function () {
    pendingRecordWrites.delete(write);
  });
  pendingRecordWrites.add(write);
  return write;
}

function diagnosticLog(level, component, event, detail) {
  if (!state.sessionId) return Promise.resolve();
  if (!state.diagnostics) state.diagnostics = freshState().diagnostics;
  var safeDetail = detail || {};
  var detailBytes = 0;
  try { detailBytes = new TextEncoder().encode(JSON.stringify(safeDetail)).length; } catch (_) {
    safeDetail = { truncated: true, reason: "diagnostic detail was not serializable" };
    detailBytes = 0;
    state.diagnostics.truncatedDetails += 1;
  }
  if (detailBytes > MAX_DIAGNOSTIC_DETAIL_BYTES) {
    safeDetail = { truncated: true, originalBytes: detailBytes, reason: "diagnostic detail exceeds per-entry limit" };
    state.diagnostics.truncatedDetails += 1;
    detailBytes = new TextEncoder().encode(JSON.stringify(safeDetail)).length;
  }
  var estimatedBytes = detailBytes + String(component || "").length + String(event || "").length + 128;
  if (state.diagnostics.recorded >= MAX_DIAGNOSTIC_LOG_ENTRIES || state.diagnostics.bytes + estimatedBytes > MAX_DIAGNOSTIC_LOG_BYTES) {
    state.diagnostics.dropped += 1;
    if (!state.diagnostics.truncationReported) {
      state.diagnostics.truncationReported = true;
      markCompletenessIssue("diagnostic-log-capture-truncated", {
        maxEntries: MAX_DIAGNOSTIC_LOG_ENTRIES,
        maxBytes: MAX_DIAGNOSTIC_LOG_BYTES,
        maxDetailBytes: MAX_DIAGNOSTIC_DETAIL_BYTES
      });
    }
    return Promise.resolve();
  }
  state.diagnostics.recorded += 1;
  state.diagnostics.bytes += estimatedBytes;
  return addRecord("diagnosticLog", {
    level: level || "info",
    component: component || "extension",
    event: event || "diagnostic",
    detail: safeDetail
  });
}

function errorDiagnostic(error) {
  return {
    name: error && error.name || "Error",
    message: error && error.message || String(error || "Unknown error"),
    stack: error && typeof error.stack === "string" ? error.stack : ""
  };
}

function isApiType(type) {
  return type === "XHR" || type === "Fetch";
}

function sourceKey(source) {
  if (source && source.sessionId) return "session:" + (source.tabId || state.tabId) + ":" + source.sessionId;
  if (source && source.targetId) return "target:" + source.targetId;
  return "tab:" + (source && source.tabId);
}

function requestBaseKey(source, requestId) {
  return sourceKey(source) + "|" + requestId;
}

function debuggeeForSource(source) {
  if (source && source.sessionId) return { tabId: source.tabId || state.tabId, sessionId: source.sessionId };
  return source && source.targetId ? { targetId: source.targetId } : { tabId: state.tabId };
}

function isCapturedSource(source) {
  if (!source) return false;
  if (source.sessionId) return capturedSessions.has(source.sessionId);
  if (source.tabId === state.tabId) return true;
  return !!(source.targetId && capturedTargets.has(source.targetId));
}

function targetDescriptor(source) {
  if (source && source.sessionId) {
    var sessionInfo = capturedSessions.get(source.sessionId) || {};
    return { targetId: sessionInfo.targetId || "", sessionId: source.sessionId, type: sessionInfo.type || "other", url: sessionInfo.url || "", title: sessionInfo.title || "" };
  }
  if (source && source.targetId) {
    var info = capturedTargets.get(source.targetId) || targetInfoMap.get(source.targetId) || {};
    return { targetId: source.targetId, type: info.type || "other", url: info.url || "", title: info.title || "" };
  }
  return { targetId: rootTargetId || "", type: "page", url: state.url || "", title: state.title || "", tabId: state.tabId };
}

function requestKey(source, requestId) {
  var base = requestBaseKey(source, requestId);
  var generation = requestGenerations.get(base) || 0;
  return base + (generation ? "#redirect-" + generation : "");
}

function advanceRequestGeneration(source, requestId) {
  var base = requestBaseKey(source, requestId);
  requestGenerations.set(base, (requestGenerations.get(base) || 0) + 1);
  return requestKey(source, requestId);
}

function appendMapValue(map, key, value) {
  var values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function rememberRequestHop(source, requestId, key) {
  appendMapValue(requestHopKeys, requestBaseKey(source, requestId), key);
}

function expectResponseExtraInfo(source, requestId, key) {
  appendMapValue(responseExtraExpectedKeys, requestBaseKey(source, requestId), key);
}

function bufferExtraInfo(map, source, requestId, data) {
  appendMapValue(map, requestBaseKey(source, requestId), data);
}

async function flushAllExtraInfo() {
  var bases = new Set();
  requestExtraBuffers.forEach(function (_, key) { bases.add(key); });
  responseExtraBuffers.forEach(function (_, key) { bases.add(key); });
  responseExtraExpectedKeys.forEach(function (_, key) { bases.add(key); });
  for (var base of bases) {
    var requestExtras = requestExtraBuffers.get(base) || [];
    var requestKeys = requestHopKeys.get(base) || [];
    var responseExtras = responseExtraBuffers.get(base) || [];
    var responseKeys = responseExtraExpectedKeys.get(base) || [];
    var requestExact = requestExtras.length === 0 || requestExtras.length === requestKeys.length;
    var responseExact = responseExtras.length === responseKeys.length;
    for (var i = 0; i < requestExtras.length; i += 1) {
      requestExtras[i].requestKey = requestExact ? requestKeys[i] : null;
      requestExtras[i].association = requestExact ? "exact-by-complete-hop-sequence" : "ambiguous";
      if (!requestExact) requestExtras[i].requestKeyCandidates = requestKeys.slice();
      await addRecord("requestExtraInfo", requestExtras[i]);
    }
    for (var j = 0; j < responseExtras.length; j += 1) {
      responseExtras[j].requestKey = responseExact ? responseKeys[j] : null;
      responseExtras[j].association = responseExact ? "exact-by-cdp-extra-info-flags" : "ambiguous";
      if (!responseExact) responseExtras[j].requestKeyCandidates = responseKeys.slice();
      await addRecord("responseExtraInfo", responseExtras[j]);
    }
    if ((!requestExact || !responseExact) && !extraInfoAssociationIssues.has(base)) {
      extraInfoAssociationIssues.add(base);
      markCompletenessIssue("extra-info-association-ambiguous", {
        requestBaseKey: base,
        requestExtraCount: requestExtras.length,
        requestHopCount: requestKeys.length,
        responseExtraCount: responseExtras.length,
        expectedResponseExtraCount: responseKeys.length
      });
      await addRecord("extraInfoAssociationGap", { requestBaseKey: base, requestKeys: requestKeys, responseKeys: responseKeys });
    }
  }
  requestExtraBuffers.clear();
  responseExtraBuffers.clear();
  requestHopKeys.clear();
  responseExtraExpectedKeys.clear();
}

async function waitForPendingDebuggerEvents() {
  var deadline = Date.now() + 15000;
  while (pendingDebuggerEvents.size && Date.now() < deadline) {
    await Promise.all(Array.from(pendingDebuggerEvents).map(function (promise) { return promise.catch(function () {}); }));
  }
  if (pendingDebuggerEvents.size) {
    markCompletenessIssue("debugger-event-drain-timeout", { pending: pendingDebuggerEvents.size });
    await addRecord("eventDrainTimeout", { pending: pendingDebuggerEvents.size });
  }
}

async function waitForPendingRecordWrites() {
  var deadline = Date.now() + 15000;
  while (pendingRecordWrites.size && Date.now() < deadline) {
    await Promise.all(Array.from(pendingRecordWrites).map(function (promise) { return promise.catch(function () {}); }));
  }
  if (pendingRecordWrites.size) markCompletenessIssue("record-write-drain-timeout", { pending: pendingRecordWrites.size });
}

async function waitForDebuggerQuiet() {
  var deadline = Date.now() + 1000;
  while (Date.now() < deadline && Date.now() - lastDebuggerEventAt < 100) {
    await new Promise(function (resolve) { setTimeout(resolve, 25); });
  }
}

async function stopTargetPolling() {
  if (targetPollTimer) clearTimeout(targetPollTimer);
  targetPollTimer = null;
  var deadline = Date.now() + 5000;
  while (targetPollRunning && Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 25); });
  }
  if (targetPollRunning) {
    markCompletenessIssue("target-poll-drain-timeout", {});
    await addRecord("targetDiscoveryFailed", { phase: "stop", reason: "target polling did not drain before detach" });
  }
}

function correlationForNow() {
  if (!lastInteraction) return null;
  var delay = Date.now() - lastInteraction.atMs;
  if (delay < -250 || delay > CORRELATION_WINDOW_MS) return null;
  return {
    interactionId: lastInteraction.id,
    interactionKind: lastInteraction.kind,
    interactionAt: lastInteraction.at,
    interactionDelayMs: delay,
    confidence: delay <= 1000 ? "high" : (delay <= 4000 ? "medium" : "low")
  };
}

async function enableCaptureDomains(debuggee, targetType) {
  var methods = ["Network.enable", "Runtime.enable", "Log.enable", "Debugger.enable"];
  if (targetType === "page" || targetType === "iframe" || !targetType) methods.push("Page.enable");
  var failures = [];
  for (var i = 0; i < methods.length; i += 1) {
    try {
      await command(debuggee, methods[i]);
    } catch (error) {
      failures.push({ method: methods[i], reason: error.message || String(error) });
    }
  }
  if (failures.length) {
    markCompletenessIssue("capture-domain-enable-failed", { debuggee: sourceKey(debuggee), failures: failures });
    await addRecord("captureDomainEnableFailed", { debuggee: sourceKey(debuggee), targetType: targetType || "unknown", failures: failures });
  }
  if (failures.some(function (failure) { return failure.method === "Network.enable" || failure.method === "Runtime.enable"; })) {
    throw new Error("required CDP capture domains could not be enabled");
  }
  return failures;
}

function updateTargetCounter() {
  state.counters.targets = capturedTargets.size + capturedSessions.size;
  schedulePersist();
}

function capturedSessionHasTarget(targetId) {
  var found = false;
  capturedSessions.forEach(function (info) {
    if (info && info.targetId === targetId) found = true;
  });
  return found;
}

function rememberAllowedOrigin(url) {
  var origin = WebCaptrueTargets.originForUrl(url);
  if (origin && origin !== "null") allowedTargetOrigins.add(origin);
}

function rememberAllowedTargetUrl(url) {
  try {
    var normalized = new URL(String(url || ""), state.url || undefined).href;
    if (/^(https?|blob):/i.test(normalized)) allowedTargetUrls.add(normalized);
  } catch (_) {}
}

async function discoveryCommand(debuggee, method, params, optionalFallback) {
  try {
    return await command(debuggee, method, params);
  } catch (error) {
    var code = "target-discovery-command-failed:" + method;
    if (!targetDiscoveryFailureCodes.has(code)) {
      targetDiscoveryFailureCodes.add(code);
      if (optionalFallback) {
        await addRecord("targetDiscoveryFallback", { method: method, reason: error.message || String(error), fallback: "chrome.debugger.getTargets and auto-attach" });
      } else {
        markCompletenessIssue("target-discovery-command-failed", { method: method, reason: error.message || String(error) });
        await addRecord("targetDiscoveryFailed", { method: method, reason: error.message || String(error) });
      }
    }
    return null;
  }
}

async function refreshAllowedTargetUrls(root, force) {
  if (!force && Date.now() - lastTargetScopeRefreshAt < 1000) return;
  lastTargetScopeRefreshAt = Date.now();
  var observedTargets = await discoveryCommand(root, "Runtime.evaluate", {
    expression: "Promise.all([Promise.resolve(performance.getEntriesByType('resource').map(function(e){return e.name;})), navigator.serviceWorker && navigator.serviceWorker.getRegistrations ? navigator.serviceWorker.getRegistrations().then(function(rs){return rs.reduce(function(out,r){['active','waiting','installing'].forEach(function(k){if(r[k]&&r[k].scriptURL)out.push(r[k].scriptURL);});return out;},[]);}) : Promise.resolve([])]).then(function(x){return x[0].concat(x[1]);})",
    returnByValue: true,
    awaitPromise: true
  });
  (((observedTargets || {}).result || {}).value || []).forEach(rememberAllowedTargetUrl);
}

function updateAmbiguousTargetOrigins(targets) {
  ambiguousTargetOrigins.clear();
  (targets || []).forEach(function (rawInfo) {
    var info = WebCaptrueTargets.normalize(rawInfo);
    if (info.type !== "page" || typeof info.tabId !== "number" || info.tabId === state.tabId) return;
    var origin = WebCaptrueTargets.originForUrl(info.url);
    if (origin && allowedTargetOrigins.has(origin)) {
      ambiguousTargetOrigins.add(origin);
      if (!reportedAmbiguousTargetOrigins.has(origin)) {
        reportedAmbiguousTargetOrigins.add(origin);
        markCompletenessIssue("target-attribution-ambiguous", { origin: origin, otherTabId: info.tabId });
        addRecord("targetAttributionGap", { origin: origin, otherTabId: info.tabId, reason: "same-origin page open in another tab; no-tabId fallback targets are excluded" });
      }
    }
  });
}

async function reportUnattributedTargetCandidate(rawInfo) {
  var info = WebCaptrueTargets.normalize(rawInfo);
  if (!info.targetId || reportedUnattributedTargetIds.has(info.targetId) || typeof info.tabId === "number" || !capturableTargetType(info.type)) return;
  var origin = WebCaptrueTargets.originForUrl(info.url);
  if (!origin || !allowedTargetOrigins.has(origin) || ambiguousTargetOrigins.has(origin) || allowedTargetUrls.has(info.url)) return;
  reportedUnattributedTargetIds.add(info.targetId);
  markCompletenessIssue("target-attribution-unproven", { targetId: info.targetId, type: info.type, url: info.url || "" });
  await addRecord("targetAttributionGap", { targetId: info.targetId, type: info.type, url: info.url || "", reason: "same-origin Target URL was not observed from the captured page" });
}

function targetRelatedToRoot(info) {
  if (!info || !rootTargetId || info.targetId === rootTargetId) return false;
  if (info.parentFrameId && rootFrameIds.has(info.parentFrameId)) return true;
  var seen = {};
  var current = info;
  while (current && current.targetId && !seen[current.targetId]) {
    seen[current.targetId] = true;
    if (current.parentId === rootTargetId || current.openerId === rootTargetId) return true;
    if (!current.parentId) return false;
    current = targetInfoMap.get(current.parentId);
    if (current && current.targetId === rootTargetId) return true;
  }
  return false;
}

function capturableTargetType(type) {
  return WebCaptrueTargets.isCapturableType(type);
}

async function attachRelatedTarget(rawInfo, fallbackRelated) {
  var info = WebCaptrueTargets.normalize(rawInfo);
  if (!state.active || state.stopping || !info || !info.targetId || capturedTargets.has(info.targetId) || capturedSessionHasTarget(info.targetId)) return;
  if (!capturableTargetType(info.type) || (!fallbackRelated && !targetRelatedToRoot(info))) return;
  var debuggee = { targetId: info.targetId };
  try {
    await debuggerAttach(debuggee);
    capturedTargets.set(info.targetId, info);
    updateTargetCounter();
    await enableCaptureDomains(debuggee, info.type);
    await tryCommand(debuggee, "Runtime.runIfWaitingForDebugger");
    await addRecord("targetAttached", { mode: "targetId", targetId: info.targetId, type: info.type, title: info.title || "", url: info.url || "", parentId: info.parentId || "", parentFrameId: info.parentFrameId || "" });
  } catch (error) {
    state.completeness.targetAttachFailures += 1;
    markCompletenessIssue("target-attach-failed", { targetId: info.targetId, type: info.type, url: info.url || "", reason: error.message || String(error) });
    await addRecord("targetAttachFailed", { targetId: info.targetId, type: info.type, url: info.url || "", reason: error.message || String(error) });
  }
}

async function enableFlatAutoAttach(debuggee) {
  try {
    await command(debuggee, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return true;
  } catch (error) {
    markCompletenessIssue("flat-auto-attach-unavailable", { reason: error.message || String(error) });
    await addRecord("targetAutoAttachFailed", { mode: "flat-session", reason: error.message || String(error) });
    return false;
  }
}

async function attachFlatSession(source, params) {
  var info = WebCaptrueTargets.normalize(params && params.targetInfo);
  var sessionId = params && params.sessionId;
  if (state.stopping || !sessionId || !info.targetId || capturedSessions.has(sessionId)) return;
  capturedSessions.set(sessionId, info);
  targetInfoMap.set(info.targetId, info);
  state.completeness.targetCandidates += 1;
  updateTargetCounter();
  var session = { tabId: source.tabId || state.tabId, sessionId: sessionId };
  try {
    await enableCaptureDomains(session, info.type);
    await enableFlatAutoAttach(session);
    await tryCommand(session, "Runtime.runIfWaitingForDebugger");
    await addRecord("targetAttached", { mode: "flat-session", sessionId: sessionId, targetId: info.targetId, type: info.type, title: info.title || "", url: info.url || "" });
  } catch (error) {
    capturedSessions.delete(sessionId);
    updateTargetCounter();
    state.completeness.targetAttachFailures += 1;
    markCompletenessIssue("target-session-enable-failed", { targetId: info.targetId, type: info.type, reason: error.message || String(error) });
    await addRecord("targetAttachFailed", { mode: "flat-session", sessionId: sessionId, targetId: info.targetId, type: info.type, url: info.url || "", reason: error.message || String(error) });
  }
}

async function attachExistingFlatTarget(rawInfo) {
  var info = WebCaptrueTargets.normalize(rawInfo);
  if (!state.active || state.stopping || !info.targetId || capturedSessionHasTarget(info.targetId)) return;
  if (!WebCaptrueTargets.isFallbackCandidate(info, {
    rootTargetId: rootTargetId,
    rootTabId: state.tabId,
    allowedOrigins: Array.from(allowedTargetOrigins),
    allowedUrls: Array.from(allowedTargetUrls),
    ambiguousOrigins: Array.from(ambiguousTargetOrigins)
  })) return;
  state.completeness.targetCandidates += 1;
  try {
    var result = await command({ tabId: state.tabId }, "Target.attachToTarget", { targetId: info.targetId, flatten: true });
    if (!result.sessionId) throw new Error("Target.attachToTarget returned no sessionId");
    await attachFlatSession({ tabId: state.tabId }, { sessionId: result.sessionId, targetInfo: info });
  } catch (error) {
    state.completeness.targetAttachFailures += 1;
    markCompletenessIssue("target-attach-failed", { targetId: info.targetId, type: info.type, url: info.url || "", reason: error.message || String(error) });
    await addRecord("targetAttachFailed", { mode: "flat-session-sweep", targetId: info.targetId, type: info.type, url: info.url || "", reason: error.message || String(error) });
  }
}

async function pollLegacyTargets() {
  if (!state.active || state.stopping || targetPollRunning) return;
  targetPollRunning = true;
  try {
    state.completeness.targetScans += 1;
    await refreshAllowedTargetUrls({ tabId: state.tabId }, false);
    var globalSnapshot = await debuggerGetTargets();
    updateAmbiguousTargetOrigins(globalSnapshot);
    var newlySeen = [];
    if (flatSessionsSupported) {
      var protocolResult = await discoveryCommand({ tabId: state.tabId }, "Target.getTargets", undefined, true);
      var protocolTargets = protocolResult && protocolResult.targetInfos || [];
      for (var p = 0; p < protocolTargets.length; p += 1) {
        var protocolInfo = WebCaptrueTargets.normalize(protocolTargets[p]);
        targetInfoMap.set(protocolInfo.targetId, protocolInfo);
        if (!WebCaptrueTargets.isFallbackCandidate(protocolInfo, {
          rootTargetId: rootTargetId,
          rootTabId: state.tabId,
          allowedOrigins: Array.from(allowedTargetOrigins),
          allowedUrls: Array.from(allowedTargetUrls),
          ambiguousOrigins: Array.from(ambiguousTargetOrigins)
        })) {
          await reportUnattributedTargetCandidate(protocolInfo);
          continue;
        }
        if (!legacySeenTargetIds.has(protocolInfo.targetId)) {
          legacySeenTargetIds.add(protocolInfo.targetId);
          newlySeen.push({ targetId: protocolInfo.targetId, type: protocolInfo.type, url: protocolInfo.url || "" });
        }
        await attachExistingFlatTarget(protocolInfo);
      }
      var globalTargets = globalSnapshot;
      for (var g = 0; g < globalTargets.length; g += 1) {
        var globalInfo = WebCaptrueTargets.normalize(globalTargets[g]);
        targetInfoMap.set(globalInfo.targetId, globalInfo);
        if (!WebCaptrueTargets.isFallbackCandidate(globalInfo, {
          rootTargetId: rootTargetId,
          rootTabId: state.tabId,
          allowedOrigins: Array.from(allowedTargetOrigins),
          allowedUrls: Array.from(allowedTargetUrls),
          ambiguousOrigins: Array.from(ambiguousTargetOrigins)
        })) {
          await reportUnattributedTargetCandidate(globalInfo);
          continue;
        }
        if (!legacySeenTargetIds.has(globalInfo.targetId)) {
          legacySeenTargetIds.add(globalInfo.targetId);
          newlySeen.push({ targetId: globalInfo.targetId, type: globalInfo.type, url: globalInfo.url || "" });
        }
        await attachRelatedTarget(globalInfo, true);
      }
      if (newlySeen.length) await addRecord("targetDiscovery", { mode: "flat-session-sweep", discovered: newlySeen });
      return;
    }
    var targets = globalSnapshot;
    for (var i = 0; i < targets.length; i += 1) {
      var info = WebCaptrueTargets.normalize(targets[i]);
      if (info.type === "page" && info.tabId === state.tabId) rootTargetId = info.targetId;
      targetInfoMap.set(info.targetId, info);
      if (!WebCaptrueTargets.isFallbackCandidate(info, {
        rootTargetId: rootTargetId,
        rootTabId: state.tabId,
        allowedOrigins: Array.from(allowedTargetOrigins),
        allowedUrls: Array.from(allowedTargetUrls),
        ambiguousOrigins: Array.from(ambiguousTargetOrigins)
      })) {
        await reportUnattributedTargetCandidate(info);
        continue;
      }
      if (!legacySeenTargetIds.has(info.targetId)) {
        legacySeenTargetIds.add(info.targetId);
        newlySeen.push({ targetId: info.targetId, type: info.type, url: info.url || "" });
        state.completeness.targetCandidates += 1;
      }
      await attachRelatedTarget(info, true);
    }
    if (newlySeen.length) await addRecord("targetDiscovery", { mode: "chrome-debugger-poll", discovered: newlySeen });
  } catch (error) {
    markCompletenessIssue("target-poll-failed", { reason: error.message || String(error) });
  } finally {
    targetPollRunning = false;
    if (state.active && !state.stopping) targetPollTimer = setTimeout(pollLegacyTargets, 250);
  }
}

async function discoverRelatedTargets() {
  var extensionTargets = [];
  try {
    extensionTargets = await debuggerGetTargets();
  } catch (error) {
    markCompletenessIssue("target-list-failed", { phase: "initial", reason: error.message || String(error) });
    await addRecord("targetDiscoveryFailed", { phase: "initial", reason: error.message || String(error) });
  }
  for (var i = 0; i < extensionTargets.length; i += 1) {
    if (extensionTargets[i].tabId === state.tabId && extensionTargets[i].type === "page") {
      rootTargetId = extensionTargets[i].id;
      break;
    }
  }
  var root = { tabId: state.tabId };
  var frameTree = await discoveryCommand(root, "Page.getFrameTree");
  rootFrameIds.clear();
  allowedTargetOrigins.clear();
  allowedTargetUrls.clear();
  rememberAllowedOrigin(state.url);
  (function collectFrames(node) {
    if (!node || !node.frame) return;
    if (node.frame.id) rootFrameIds.add(node.frame.id);
    rememberAllowedOrigin(node.frame.url);
    rememberAllowedTargetUrl(node.frame.url);
    (node.resources || []).forEach(function (resource) { rememberAllowedTargetUrl(resource.url); });
    (node.childFrames || []).forEach(collectFrames);
  }(frameTree && frameTree.frameTree));
  await refreshAllowedTargetUrls(root, true);
  flatSessionsSupported = WebCaptrueTargets.supportsFlatSessions(navigator.userAgent);
  await discoveryCommand(root, "Target.setDiscoverTargets", { discover: true }, flatSessionsSupported);
  var result = await discoveryCommand(root, "Target.getTargets", undefined, flatSessionsSupported);
  var infos = result && result.targetInfos || [];
  infos.forEach(function (info) { targetInfoMap.set(info.targetId, info); });
  for (var j = 0; j < infos.length; j += 1) await attachRelatedTarget(infos[j]);
  state.completeness.targetMode = flatSessionsSupported ? "flat-session" : "targetId-poll";
  var flatEnabled = flatSessionsSupported ? await enableFlatAutoAttach(root) : false;
  if (flatSessionsSupported && !flatEnabled) {
    flatSessionsSupported = false;
    state.completeness.targetMode = "targetId-poll-fallback";
  }
  await addRecord("targetDiscovery", { mode: state.completeness.targetMode, rootTargetId: rootTargetId || "", discovered: infos.map(function (info) { return { targetId: info.targetId, type: info.type, url: info.url || "", parentId: info.parentId || "" }; }) });
  await pollLegacyTargets();
}

async function detachChildTargets() {
  if (targetPollTimer) clearTimeout(targetPollTimer);
  targetPollTimer = null;
  var ids = Array.from(capturedTargets.keys());
  for (var i = 0; i < ids.length; i += 1) {
    var debuggee = { targetId: ids[i] };
    var key = sourceKey(debuggee);
    expectedDetachKeys.add(key);
    await debuggerDetach(debuggee);
  }
}
