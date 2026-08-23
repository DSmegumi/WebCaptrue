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
    } else {
      await addRecord("clientStorageSnapshotSkipped", { label: label, frameId: frames[i].frameId, frameUrl: frames[i].url || "", reason: response && response.error || "content script unavailable" });
    }
  }
  schedulePersist();
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
  capturedTargets.clear();
  capturedSessions.clear();
  targetInfoMap.clear();
  rootFrameIds.clear();
  allowedTargetOrigins.clear();
  expectedDetachKeys.clear();
  legacySeenTargetIds.clear();
  rootTargetId = null;
  flatSessionsSupported = false;
  if (targetPollTimer) clearTimeout(targetPollTimer);
  targetPollTimer = null;
  targetPollRunning = false;
  lastInteraction = null;
  lastScreenshotAt = 0;
  await db.clearSession(sessionId);
  try {
    await enableCaptureDomains(debuggee, "page");
  } catch (error) {
    state.active = false;
    expectedDetachKeys.add(sourceKey(debuggee));
    await debuggerDetach(debuggee);
    expectedDetachKeys.delete(sourceKey(debuggee));
    throw error;
  }
  await addRecord("sessionStart", { url: state.url, title: state.title, options: state.options, userAgent: navigator.userAgent });
  schedulePersist();
  try {
    var injectedFrames = await executeContentScript(tabId);
    await addRecord("contentScriptReady", { frameCount: injectedFrames.length });
  } catch (error2) {
    markCompletenessIssue("content-script-injection-failed", { reason: error2.message || String(error2) });
    await addRecord("contentScriptInjectionFailed", { reason: error2.message || String(error2) });
  }
  await discoverRelatedTargets();
  await captureExistingResources();
  await capturePageState("start");
  await captureClientStorage("start");
  await captureFullPageScreenshot("start");
  return cloneState();
}

async function stopCapture() {
  if (!state.active) return { state: cloneState(), filename: null };
  var stoppedState;
  var sessionId = state.sessionId;
  var debuggee = { tabId: state.tabId };

  await capturePageState("final");
  await captureClientStorage("final");
  await captureFullPageScreenshot("final");
  await addRecord("sessionStop", { stoppedAt: new Date().toISOString(), counters: state.counters });
  await detachChildTargets();
  await tryCommand(debuggee, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: flatSessionsSupported });
  await tryCommand(debuggee, "Target.setDiscoverTargets", { discover: false });
  expectedDetachKeys.add(sourceKey(debuggee));
  await debuggerDetach(debuggee);
  expectedDetachKeys.delete(sourceKey(debuggee));

  state.active = false;
  schedulePersist();
  stoppedState = cloneState();

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
