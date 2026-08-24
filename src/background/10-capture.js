"use strict";

async function capturePageState(label) {
  if (!state.active || typeof state.tabId !== "number") return;
  var debuggee = { tabId: state.tabId };
  try {
    var dom = await command(debuggee, "Runtime.evaluate", {
      expression: "document.documentElement ? document.documentElement.outerHTML : ''",
      returnByValue: true,
      awaitPromise: false
    });
    await addRecord("domSnapshot", { label: label, html: dom.result && dom.result.value || "" });
  } catch (error) {
    await addRecord("captureError", { operation: "dom-html-snapshot", label: label, reason: error.message || String(error) });
  }
  try {
    var structured = await command(debuggee, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: false
    });
    await addRecord("domStructuredSnapshot", { label: label, snapshot: structured });
  } catch (error2) {
    await addRecord("captureError", { operation: "dom-structured-snapshot", label: label, reason: error2.message || String(error2) });
  }
}

async function captureClientStorage(label) {
  if (!state.active || !state.options.captureClientStorage) return;
  var frames = await getAllFrames(state.tabId);
  if (!frames.length) frames = [{ frameId: 0, url: state.url }];
  for (var i = 0; i < frames.length; i += 1) {
    var response = await sendTabMessage(state.tabId, { type: "REQUEST_CLIENT_STORAGE", label: label }, frames[i].frameId);
    if (response && response.ok && response.snapshot) {
      state.counters.storageSnapshots += 1;
      await addRecord("clientStorageSnapshot", {
        label: label,
        frameId: frames[i].frameId,
        parentFrameId: frames[i].parentFrameId,
        frameUrl: frames[i].url || response.snapshot.frameUrl || "",
        snapshot: response.snapshot
      });
      var storageIssues = collectStorageIssues(response.snapshot);
      if (storageIssues.length) {
        await addRecord("clientStorageTruncation", {
          label: label,
          frameId: frames[i].frameId,
          frameUrl: frames[i].url || response.snapshot.frameUrl || "",
          issues: storageIssues,
          issueCount: storageIssues.length
        });
      }
    } else {
      await addRecord("clientStorageSnapshotSkipped", { label: label, frameId: frames[i].frameId, frameUrl: frames[i].url || "", reason: response && response.error || "content script unavailable" });
    }
  }
  schedulePersist();
}

function collectStorageIssues(snapshot) {
  var issues = [];
  function visit(value, path, depth) {
    if (issues.length >= 500 || depth > 20 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/\[(?:TRUNCATED|MAX_DEPTH)/.test(value)) issues.push({ path: path, reason: "value truncated" });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item, index) { visit(item, path + "[" + index + "]", depth + 1); });
      return;
    }
    if (typeof value !== "object") return;
    Object.keys(value).forEach(function (key) {
      var childPath = path + "." + key;
      if ((key === "truncated" && value[key] === true) || key === "bodySkipped" || key === "error" || key === "_error" || /^_webcaptrueTruncated/.test(key)) {
        if (value[key]) issues.push({ path: childPath, reason: String(value[key]) });
      }
      visit(value[key], childPath, depth + 1);
    });
  }
  visit(snapshot, "$", 0);
  return issues;
}

async function captureVisibleScreenshot(label, force) {
  if (!state.active || typeof state.tabId !== "number") return;
  var now = Date.now();
  if (!force && now - lastScreenshotAt < 1200) return;
  try {
    var tab = await getTab(state.tabId);
    if (!tab.active) return;
    var dataUrl = await captureVisible(tab.windowId);
    lastScreenshotAt = now;
    state.counters.screenshots += 1;
    schedulePersist();
    await addRecord("screenshot", { label: label, mode: "visible", dataUrl: dataUrl });
  } catch (error) {
    await addRecord("captureError", { operation: "visible-screenshot", label: label, reason: error.message || String(error) });
  }
}

async function captureFullPageScreenshot(label) {
  if (!state.active || typeof state.tabId !== "number") return;
  var debuggee = { tabId: state.tabId };
  try {
    var metrics = await command(debuggee, "Page.getLayoutMetrics");
    var size = metrics.cssContentSize || metrics.contentSize || {};
    var width = Math.max(1, Math.ceil(size.width || 0));
    var height = Math.max(1, Math.ceil(size.height || 0));
    if (!width || !height) throw new Error("layout size unavailable");
    var scale = Math.min(1, 16000 / width, 16000 / height, Math.sqrt(50000000 / (width * height)));
    if (!isFinite(scale) || scale <= 0) scale = 1;
    var shot = await command(debuggee, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: width, height: height, scale: scale }
    });
    state.counters.screenshots += 1;
    lastScreenshotAt = Date.now();
    schedulePersist();
    await addRecord("screenshot", {
      label: label,
      mode: "full-page",
      width: width,
      height: height,
      scale: scale,
      dataUrl: "data:image/png;base64," + (shot.data || "")
    });
  } catch (error) {
    await addRecord("fullPageScreenshotFallback", { label: label, reason: error.message || String(error) });
    await captureVisibleScreenshot(label + "-visible-fallback", true);
  }
}

async function captureExistingResources() {
  if (!state.active || typeof state.tabId !== "number") return;
  var debuggee = { tabId: state.tabId };
  var tree;
  try {
    tree = await command(debuggee, "Page.getResourceTree");
  } catch (error) {
    await addRecord("captureError", { operation: "resource-tree", reason: error.message || String(error) });
    return;
  }

  async function visit(frameTree) {
    if (!frameTree || !frameTree.frame) return;
    var frameId = frameTree.frame.id;
    var resources = frameTree.resources || [];
    for (var i = 0; i < resources.length; i += 1) {
      var resource = resources[i];
      try {
        var content = await command(debuggee, "Page.getResourceContent", { frameId: frameId, url: resource.url });
        var body = content.content || "";
        var approximateBytes = content.base64Encoded ? Math.floor(body.length * 0.75) : body.length;
        if (approximateBytes > MAX_BODY_BYTES) {
          await addRecord("preloadedResourceSkipped", { url: resource.url, type: resource.type, mimeType: resource.mimeType, reason: "resource exceeds limit" });
        } else {
          await addRecord("preloadedResource", {
            frameId: frameId,
            url: resource.url,
            resourceType: resource.type,
            mimeType: resource.mimeType || "",
            base64Encoded: !!content.base64Encoded,
            body: body
          });
        }
      } catch (error) {
        await addRecord("preloadedResourceSkipped", { url: resource.url, type: resource.type, mimeType: resource.mimeType, reason: error.message || String(error) });
      }
    }
    var children = frameTree.childFrames || [];
    for (var j = 0; j < children.length; j += 1) await visit(children[j]);
  }

  await visit(tree.frameTree);
}

async function startCapture(tabId, options) {
  if (state.active) throw new Error("已有采集任务正在运行");
  var tab = await getTab(tabId);
  if (!tab.url || /^(chrome|edge|about|devtools):/i.test(tab.url)) throw new Error("当前页面不允许扩展调试，请打开普通网页后重试");

  await ensureOffscreen();
  var debuggee = { tabId: tabId };
  await debuggerAttach(debuggee);

  var sessionId = "cap-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  state = freshState();
  state.active = true;
  state.sessionId = sessionId;
  state.tabId = tabId;
  state.startedAt = new Date().toISOString();
  state.url = tab.url;
  state.title = tab.title || "";
  state.options = {
    captureBodies: !options || options.captureBodies !== false,
    autoScreenshots: !options || options.autoScreenshots !== false,
    captureClientStorage: !options || options.captureClientStorage !== false
  };
  requestMap.clear();
  requestGenerations.clear();
  requestHopKeys.clear();
  requestExtraBuffers.clear();
  responseExtraExpectedKeys.clear();
  responseExtraBuffers.clear();
  extraInfoAssociationIssues.clear();
  debuggerEventQueues.clear();
  pendingDebuggerEvents.clear();
  pendingRecordWrites.clear();
  capturedTargets.clear();
  capturedSessions.clear();
  targetInfoMap.clear();
  rootFrameIds.clear();
  allowedTargetOrigins.clear();
  allowedTargetUrls.clear();
  ambiguousTargetOrigins.clear();
  reportedAmbiguousTargetOrigins.clear();
  reportedUnattributedTargetIds.clear();
  expectedDetachKeys.clear();
  legacySeenTargetIds.clear();
  rootTargetId = null;
  flatSessionsSupported = false;
  if (targetPollTimer) clearTimeout(targetPollTimer);
  targetPollTimer = null;
  targetPollRunning = false;
  lastInteraction = null;
  lastScreenshotAt = 0;
  lastDebuggerEventAt = 0;
  lastTargetScopeRefreshAt = 0;
  targetDiscoveryFailureCodes.clear();
  state.stopping = false;
  await db.clearSession(sessionId);
  await diagnosticLog("info", "capture", "capture-started", {
    tabId: tabId,
    url: state.url,
    options: state.options
  });
  try {
    await enableCaptureDomains(debuggee, "page");
  } catch (error) {
    state.active = false;
    expectedDetachKeys.add(sourceKey(debuggee));
    await debuggerDetach(debuggee);
    expectedDetachKeys.delete(sourceKey(debuggee));
    throw error;
  }
  await diagnosticLog("info", "capture", "root-domains-enabled", { protocolVersion: PROTOCOL_VERSION });
  await addRecord("sessionStart", {
    url: state.url,
    title: state.title,
    options: state.options,
    environment: {
      extensionVersion: chrome.runtime.getManifest().version,
      minimumChromeVersion: 109,
      userAgent: navigator.userAgent,
      platform: navigator.platform || "",
      language: navigator.language || ""
    }
  });
  schedulePersist();
  try {
    var injectedFrames = await executeContentScript(tabId);
    await addRecord("contentScriptReady", { frameCount: injectedFrames.length });
    await diagnosticLog("info", "capture", "content-script-ready", { frameCount: injectedFrames.length });
  } catch (error2) {
    markCompletenessIssue("content-script-injection-failed", { reason: error2.message || String(error2) });
    await addRecord("contentScriptInjectionFailed", { reason: error2.message || String(error2) });
  }
  await discoverRelatedTargets();
  await diagnosticLog("info", "targets", "target-discovery-completed", {
    mode: state.completeness.targetMode,
    scans: state.completeness.targetScans,
    candidates: state.completeness.targetCandidates,
    attached: state.counters.targets
  });
  await captureExistingResources();
  await capturePageState("start");
  await captureClientStorage("start");
  await captureFullPageScreenshot("start");
  await diagnosticLog("info", "capture", "initial-capture-completed", { counters: state.counters });
  return cloneState();
}

async function stopCapture() {
  if (!state.active) return { state: cloneState(), filename: null };
  var stoppedState;
  var sessionId = state.sessionId;
  var debuggee = { tabId: state.tabId };
  state.stopping = true;
  await diagnosticLog("info", "capture", "stop-requested", { counters: state.counters });
  await stopTargetPolling();

  await capturePageState("final");
  await captureClientStorage("final");
  await captureFullPageScreenshot("final");
  await diagnosticLog("info", "capture", "final-snapshots-completed", { counters: state.counters });
  await detachChildTargets();
  await tryCommand(debuggee, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: flatSessionsSupported });
  await discoveryCommand(debuggee, "Target.setDiscoverTargets", { discover: false }, true);
  expectedDetachKeys.add(sourceKey(debuggee));
  await debuggerDetach(debuggee);
  lastDebuggerEventAt = Date.now();
  await waitForDebuggerQuiet();
  await waitForPendingDebuggerEvents();
  await flushAllExtraInfo();
  await diagnosticLog("info", "capture", "debugger-events-drained", {
    pendingDebuggerEvents: pendingDebuggerEvents.size,
    pendingRecordWrites: pendingRecordWrites.size
  });
  capturedTargets.clear();
  capturedSessions.clear();
  expectedDetachKeys.clear();
  updateTargetCounter();
  await addRecord("sessionStop", { stoppedAt: new Date().toISOString(), counters: state.counters });
  await diagnosticLog("info", "capture", "capture-stopped", { counters: state.counters });
  await waitForPendingRecordWrites();

  state.active = false;
  state.stopping = false;
  schedulePersist();
  stoppedState = cloneState();
  await diagnosticLog("info", "export", "export-requested", { sessionId: sessionId, formatVersion: 3 });

  var exportResult = await runtimeSend({
    target: "offscreen",
    type: "EXPORT_SESSION",
    sessionId: sessionId,
    meta: stoppedState
  });
  var filename = "WebCaptrue_" + compactDate(new Date()) + ".zip";
  await downloadUrl(exportResult.blobUrl, filename);
  setTimeout(function () {
    chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE_BLOB", blobUrl: exportResult.blobUrl }, function () { void chrome.runtime.lastError; });
  }, 60000);
  return { state: stoppedState, filename: filename };
}

function compactDate(date) {
  function p(n) { return String(n).padStart(2, "0"); }
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + "_" + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}
