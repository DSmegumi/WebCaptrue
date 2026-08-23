"use strict";

var PROTOCOL_VERSION = "1.3";
var MAX_BODY_BYTES = 5 * 1024 * 1024;
var MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
var CORRELATION_WINDOW_MS = 10000;
var STATE_KEY = "webcaptrueRuntimeState";
var SETTINGS_KEY = "webcatrueSettings";
var db = new WebCaptrueDB();
var requestMap = new Map();
var requestGenerations = new Map();
var capturedTargets = new Map();
var capturedSessions = new Map();
var targetInfoMap = new Map();
var rootFrameIds = new Set();
var allowedTargetOrigins = new Set();
var allowedTargetUrls = new Set();
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

var state = freshState();

function freshCounters() {
  return { requests: 0, responses: 0, apis: 0, actions: 0, console: 0, screenshots: 0, targets: 0, storageSnapshots: 0 };
}

function freshState() {
  return {
    active: false,
    sessionId: null,
    tabId: null,
    startedAt: null,
    url: null,
    title: null,
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
  return db.add({
    sessionId: state.sessionId,
    type: type,
    capturedAt: new Date().toISOString(),
    data: data
  }).catch(function (error) {
    if (!state.completeness) state.completeness = freshState().completeness;
    state.completeness.recordWriteFailures += 1;
    markCompletenessIssue("record-write-failed", { type: type, reason: error && error.message || String(error) });
  });
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
  if (!state.active || !info || !info.targetId || capturedTargets.has(info.targetId) || capturedSessionHasTarget(info.targetId)) return;
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
  if (!sessionId || !info.targetId || capturedSessions.has(sessionId)) return;
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
  if (!state.active || !info.targetId || capturedSessionHasTarget(info.targetId)) return;
  if (!WebCaptrueTargets.isFallbackCandidate(info, {
    rootTargetId: rootTargetId,
    rootTabId: state.tabId,
    allowedOrigins: Array.from(allowedTargetOrigins),
    allowedUrls: Array.from(allowedTargetUrls)
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
  if (!state.active || targetPollRunning) return;
  targetPollRunning = true;
  try {
    state.completeness.targetScans += 1;
    var newlySeen = [];
    if (flatSessionsSupported) {
      var protocolResult = await tryCommand({ tabId: state.tabId }, "Target.getTargets");
      var protocolTargets = protocolResult && protocolResult.targetInfos || [];
      for (var p = 0; p < protocolTargets.length; p += 1) {
        var protocolInfo = WebCaptrueTargets.normalize(protocolTargets[p]);
        targetInfoMap.set(protocolInfo.targetId, protocolInfo);
        if (!WebCaptrueTargets.isFallbackCandidate(protocolInfo, {
          rootTargetId: rootTargetId,
          rootTabId: state.tabId,
          allowedOrigins: Array.from(allowedTargetOrigins),
          allowedUrls: Array.from(allowedTargetUrls)
        })) continue;
        if (!legacySeenTargetIds.has(protocolInfo.targetId)) {
          legacySeenTargetIds.add(protocolInfo.targetId);
          newlySeen.push({ targetId: protocolInfo.targetId, type: protocolInfo.type, url: protocolInfo.url || "" });
        }
        await attachExistingFlatTarget(protocolInfo);
      }
      var globalTargets = await debuggerGetTargets();
      for (var g = 0; g < globalTargets.length; g += 1) {
        var globalInfo = WebCaptrueTargets.normalize(globalTargets[g]);
        targetInfoMap.set(globalInfo.targetId, globalInfo);
        if (!WebCaptrueTargets.isFallbackCandidate(globalInfo, {
          rootTargetId: rootTargetId,
          rootTabId: state.tabId,
          allowedOrigins: Array.from(allowedTargetOrigins),
          allowedUrls: Array.from(allowedTargetUrls)
        })) continue;
        if (!legacySeenTargetIds.has(globalInfo.targetId)) {
          legacySeenTargetIds.add(globalInfo.targetId);
          newlySeen.push({ targetId: globalInfo.targetId, type: globalInfo.type, url: globalInfo.url || "" });
        }
        await attachRelatedTarget(globalInfo, true);
      }
      if (newlySeen.length) await addRecord("targetDiscovery", { mode: "flat-session-sweep", discovered: newlySeen });
      return;
    }
    var targets = await debuggerGetTargets();
    for (var i = 0; i < targets.length; i += 1) {
      var info = WebCaptrueTargets.normalize(targets[i]);
      if (info.type === "page" && info.tabId === state.tabId) rootTargetId = info.targetId;
      targetInfoMap.set(info.targetId, info);
      if (!WebCaptrueTargets.isFallbackCandidate(info, {
        rootTargetId: rootTargetId,
        rootTabId: state.tabId,
        allowedOrigins: Array.from(allowedTargetOrigins),
        allowedUrls: Array.from(allowedTargetUrls)
      })) continue;
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
    if (state.active) targetPollTimer = setTimeout(pollLegacyTargets, 250);
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
  var frameTree = await tryCommand(root, "Page.getFrameTree");
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
  var observedTargets = await tryCommand(root, "Runtime.evaluate", {
    expression: "Promise.all([Promise.resolve(performance.getEntriesByType('resource').map(function(e){return e.name;})), navigator.serviceWorker && navigator.serviceWorker.getRegistrations ? navigator.serviceWorker.getRegistrations().then(function(rs){return rs.map(function(r){return r.active&&r.active.scriptURL||r.waiting&&r.waiting.scriptURL||r.installing&&r.installing.scriptURL||'';});}) : Promise.resolve([])]).then(function(x){return x[0].concat(x[1]);})",
    returnByValue: true,
    awaitPromise: true
  });
  (((observedTargets || {}).result || {}).value || []).forEach(rememberAllowedTargetUrl);
  await tryCommand(root, "Target.setDiscoverTargets", { discover: true });
  var result = await tryCommand(root, "Target.getTargets");
  var infos = result && result.targetInfos || [];
  infos.forEach(function (info) { targetInfoMap.set(info.targetId, info); });
  for (var j = 0; j < infos.length; j += 1) await attachRelatedTarget(infos[j]);
  flatSessionsSupported = WebCaptrueTargets.supportsFlatSessions(navigator.userAgent);
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
    expectedDetachKeys.delete(key);
  }
  capturedTargets.clear();
  capturedSessions.clear();
  updateTargetCounter();
}
