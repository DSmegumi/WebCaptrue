"use strict";

var PROTOCOL_VERSION = "1.3";
var MAX_BODY_BYTES = 5 * 1024 * 1024;
var MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
var CORRELATION_WINDOW_MS = 10000;
var STATE_KEY = "webcaptrueRuntimeState";
var SETTINGS_KEY = "webcatrueSettings";
var db = new WebCaptrueDB();
var requestMap = new Map();
var capturedTargets = new Map();
var targetInfoMap = new Map();
var rootFrameIds = new Set();
var expectedDetachKeys = new Set();
var rootTargetId = null;
var lastInteraction = null;
var lastScreenshotAt = 0;
var persistTimer = null;

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
  return new Promise(function (resolve) {
    chrome.debugger.getTargets(function (targets) {
      if (chrome.runtime.lastError) resolve([]);
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

function isSensitiveKey(name) {
  return /(?:pass(?:word)?|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|session[_-]?id|authorization|cookie|api[_-]?key)/i.test(String(name || ""));
}

function redactStructuredValue(value) {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value && typeof value === "object") {
    var out = {};
    Object.keys(value).forEach(function (key) {
      out[key] = isSensitiveKey(key) ? "[REDACTED]" : redactStructuredValue(value[key]);
    });
    return out;
  }
  return value;
}

function sanitizePayload(text, contentType) {
  if (typeof text !== "string" || !text) return text;
  var mime = String(contentType || "").toLowerCase();
  if (mime.indexOf("json") >= 0 || /^[\s]*[]{/.test(text)) {
    try { return JSON.stringify(redactStructuredValue(JSON.parse(text))); } catch (_) {}
  }
  if (mime.indexOf("application/x-www-form-urlencoded") >= 0) {
    try {
      var params = new URLSearchParams(text);
      Array.from(params.keys()).forEach(function (key) { if (isSensitiveKey(key)) params.set(key, "[REDACTED]"); });
      return params.toString();
    } catch (_) {}
  }
  return text
    .replace(/((?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)\s*[=:]\s*)[^&\s,;]+/ig, "$1[REDACTED]")
    .replace(/("(?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)"\s*:\s*")[^"]*(")/ig, "$1[REDACTED]$2");
}

function redactHeaders(headers) {
  var out = {};
  Object.keys(headers || {}).forEach(function (name) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)) out[name] = "[REDACTED]";
    else out[name] = headers[name];
  });
  return out;
}

function addRecord(type, data) {
  if (!state.sessionId) return Promise.resolve();
  return db.add({
    sessionId: state.sessionId,
    type: type,
    capturedAt: new Date().toISOString(),
    data: data
  }).catch(function () {});
}

function isApiType(type) {
  return type === "XHR" || type === "Fetch";
}

function sourceKey(source) {
  if (source && source.targetId) return "target:" + source.targetId;
  return "tab:" + (source && source.tabId);
}

function debuggeeForSource(source) {
  return source && source.targetId ? { targetId: source.targetId } : { tabId: state.tabId };
}

function isCapturedSource(source) {
  if (!source) return false;
  if (source.tabId === state.tabId) return true;
  return !!(source.targetId && capturedTargets.has(source.targetId));
}

function targetDescriptor(source) {
  if (source && source.targetId) {
    var info = capturedTargets.get(source.targetId) || targetInfoMap.get(source.targetId) || {};
    return { targetId: source.targetId, type: info.type || "other", url: info.url || "", title: info.title || "" };
  }
  return { targetId: rootTargetId || "", type: "page", url: state.url || "", title: state.title || "", tabId: state.tabId };
}

function requestKey(source, requestId) {
  return sourceKey(source) + "|" + requestId;
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
  for (var i = 0; i < methods.length; i += 1) await tryCommand(debuggee, methods[i]);
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
  return /^(iframe|worker|shared_worker|service_worker)$/.test(String(type || ""));
}

async function attachRelatedTarget(info) {
  if (!state.active || !info || !info.targetId || capturedTargets.has(info.targetId)) return;
  if (!capturableTargetType(info.type) || !targetRelatedToRoot(info)) return;
  var debuggee = { targetId: info.targetId };
  try {
    await debuggerAttach(debuggee);
    capturedTargets.set(info.targetId, info);
    state.counters.targets = capturedTargets.size;
    schedulePersist();
    await enableCaptureDomains(debuggee, info.type);
    await addRecord("targetAttached", { targetId: info.targetId, type: info.type, title: info.title || "", url: info.url || "", parentId: info.parentId || "", parentFrameId: info.parentFrameId || "" });
  } catch (error) {
    await addRecord("targetAttachFailed", { targetId: info.targetId, type: info.type, url: info.url || "", reason: error.message || String(error) });
  }
}

async function discoverRelatedTargets() {
  var extensionTargets = await debuggerGetTargets();
  for (var i = 0; i < extensionTargets.length; i += 1) {
    if (extensionTargets[i].tabId === state.tabId && extensionTargets[i].type === "page") {
      rootTargetId = extensionTargets[i].id;
      break;
    }
  }
  var root = { tabId: state.tabId };
  var frameTree = await tryCommand(root, "Page.getFrameTree");
  rootFrameIds.clear();
  (function collectFrames(node) {
    if (!node || !node.frame) return;
    if (node.frame.id) rootFrameIds.add(node.frame.id);
    (node.childFrames || []).forEach(collectFrames);
  }(frameTree && frameTree.frameTree));
  await tryCommand(root, "Target.setDiscoverTargets", { discover: true });
  var result = await tryCommand(root, "Target.getTargets");
  var infos = result && result.targetInfos || [];
  infos.forEach(function (info) { targetInfoMap.set(info.targetId, info); });
  for (var j = 0; j < infos.length; j += 1) await attachRelatedTarget(infos[j]);
  await addRecord("targetDiscovery", { rootTargetId: rootTargetId || "", discovered: infos.map(function (info) { return { targetId: info.targetId, type: info.type, url: info.url || "", parentId: info.parentId || "" }; }) });
}

async function detachChildTargets() {
  var ids = Array.from(capturedTargets.keys());
  for (var i = 0; i < ids.length; i += 1) {
    var debuggee = { targetId: ids[i] };
    var key = sourceKey(debuggee);
    expectedDetachKeys.add(key);
    await debuggerDetach(debuggee);
    expectedDetachKeys.delete(key);
  }
  capturedTargets.clear();
  state.counters.targets = 0;
}

