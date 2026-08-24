"use strict";

function responseRecordFromPayload(requestId, key, resourceType, timestamp, res, target, redirected) {
  res = res || {};
  return {
    requestId: requestId,
    requestKey: key,
    resourceType: resourceType,
    timestamp: timestamp,
    url: res.url,
    status: res.status,
    statusText: res.statusText,
    mimeType: res.mimeType,
    protocol: res.protocol,
    remoteIPAddress: res.remoteIPAddress,
    remotePort: res.remotePort,
    fromDiskCache: !!res.fromDiskCache,
    fromServiceWorker: !!res.fromServiceWorker,
    headers: Object.assign({}, res.headers || {}),
    timing: res.timing || null,
    redirected: !!redirected,
    target: target
  };
}

async function handleDebuggerEvent(source, method, params) {
  if ((!state.active && !state.stopping) || !isCapturedSource(source)) return;
  var debuggee = debuggeeForSource(source);
  var target = targetDescriptor(source);

  if (method === "Target.attachedToTarget") {
    await attachFlatSession(source, params);
    return;
  }

  if (method === "Target.detachedFromTarget") {
    if (params.sessionId && capturedSessions.has(params.sessionId)) {
      var detachedInfo = capturedSessions.get(params.sessionId);
      capturedSessions.delete(params.sessionId);
      updateTargetCounter();
      await addRecord("targetDetached", { mode: "flat-session", sessionId: params.sessionId, targetId: detachedInfo.targetId || "", reason: params.reason || "" });
    }
    return;
  }

  if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
    var info = params.targetInfo;
    if (info && info.targetId) {
      targetInfoMap.set(info.targetId, info);
      await attachRelatedTarget(info);
    }
    return;
  }

  if (method === "Target.targetDestroyed") {
    var destroyedId = params.targetId;
    if (destroyedId) {
      targetInfoMap.delete(destroyedId);
      if (capturedTargets.has(destroyedId)) {
        capturedTargets.delete(destroyedId);
        updateTargetCounter();
        await addRecord("targetDestroyed", { targetId: destroyedId });
      }
    }
    return;
  }

  if (method === "Network.requestWillBeSent") {
    var req = params.request || {};
    var correlation = correlationForNow();
    if (params.redirectResponse) {
      var redirectKey = requestKey(source, params.requestId);
      if (params.redirectHasExtraInfo) expectResponseExtraInfo(source, params.requestId, redirectKey);
      var redirectResponse = responseRecordFromPayload(params.requestId, redirectKey, params.type, params.timestamp, params.redirectResponse, target, true);
      var redirectedRequest = requestMap.get(redirectKey) || {};
      redirectedRequest.response = redirectResponse;
      requestMap.set(redirectKey, redirectedRequest);
      state.counters.responses += 1;
      advanceRequestGeneration(source, params.requestId);
      await addRecord("response", redirectResponse);
    }
    var rec = {
      requestId: params.requestId,
      requestKey: requestKey(source, params.requestId),
      loaderId: params.loaderId,
      frameId: params.frameId,
      documentURL: params.documentURL,
      resourceType: params.type,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      method: req.method,
      url: req.url,
      headers: Object.assign({}, req.headers || {}),
      postData: req.hasPostData ? (req.postData || "[POST DATA NOT AVAILABLE]") : null,
      initiator: params.initiator || null,
      target: target,
      interaction: correlation
    };
    requestMap.set(rec.requestKey, rec);
    rememberRequestHop(source, params.requestId, rec.requestKey);
    state.counters.requests += 1;
    if (isApiType(params.type)) state.counters.apis += 1;
    schedulePersist();
    await addRecord("request", rec);
    return;
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    bufferExtraInfo(requestExtraBuffers, source, params.requestId, {
      requestId: params.requestId,
      target: target,
      eventReceivedAt: new Date().toISOString(),
      headers: Object.assign({}, params.headers || {}),
      associatedCookies: (params.associatedCookies || []).map(function (item) {
        return { blockedReasons: item.blockedReasons || [], cookie: item.cookie || null };
      })
    });
    return;
  }

  if (method === "Network.responseReceivedExtraInfo") {
    bufferExtraInfo(responseExtraBuffers, source, params.requestId, {
      requestId: params.requestId,
      target: target,
      eventReceivedAt: new Date().toISOString(),
      statusCode: params.statusCode,
      headers: Object.assign({}, params.headers || {}),
      blockedCookies: (params.blockedCookies || []).map(function (item) { return { blockedReasons: item.blockedReasons || [] }; })
    });
    return;
  }

  if (method === "Network.responseReceived") {
    var res = params.response || {};
    var responseRec = responseRecordFromPayload(params.requestId, requestKey(source, params.requestId), params.type, params.timestamp, res, target, false);
    var knownKey = requestKey(source, params.requestId);
    if (params.hasExtraInfo) expectResponseExtraInfo(source, params.requestId, knownKey);
    var known = requestMap.get(knownKey) || {};
    known.response = responseRec;
    requestMap.set(knownKey, known);
    state.counters.responses += 1;
    schedulePersist();
    await addRecord("response", responseRec);
    return;
  }

  if (method === "Network.loadingFinished") {
    if (!state.options.captureBodies) return;
    var reqKey = requestKey(source, params.requestId);
    var knownRequest = requestMap.get(reqKey) || {};
    var requestWasObserved = !!knownRequest.requestId;
    var responseUrl = (knownRequest.response && knownRequest.response.url) || knownRequest.url || "";
    if (WebCaptrueTargets.isBrowserExtensionUrl(responseUrl)) {
      await addRecord("responseBodyExcluded", { requestId: params.requestId, requestKey: reqKey, target: target, url: responseUrl, reason: "browser extension artifact outside webpage origin" });
      return;
    }
    if (params.encodedDataLength > MAX_BODY_BYTES) {
      await addRecord("responseBodySkipped", { requestId: params.requestId, requestKey: reqKey, target: target, reason: "encodedDataLength exceeds limit", encodedDataLength: params.encodedDataLength });
      return;
    }
    try {
      var body = await command(debuggee, "Network.getResponseBody", { requestId: params.requestId });
      var responseMime = (knownRequest.response && knownRequest.response.mimeType) || "";
      var bodyText = body.body || "";
      var approximateBodyBytes = body.base64Encoded ? Math.floor(bodyText.length * 0.75) : bodyText.length;
      if (approximateBodyBytes > MAX_BODY_BYTES) {
        await addRecord("responseBodySkipped", { requestId: params.requestId, requestKey: reqKey, target: target, reason: "decoded body exceeds limit", approximateBytes: approximateBodyBytes });
        return;
      }
      await addRecord("responseBody", {
        requestId: params.requestId,
        requestKey: reqKey,
        target: target,
        url: (knownRequest.response && knownRequest.response.url) || knownRequest.url || "",
        mimeType: responseMime,
        resourceType: knownRequest.resourceType || "",
        base64Encoded: !!body.base64Encoded,
        body: bodyText
      });
    } catch (error) {
      await addRecord("responseBodySkipped", { requestId: params.requestId, requestKey: reqKey, target: target, reason: error.message || String(error) });
      if (!requestWasObserved) {
        markCompletenessIssue("pre-capture-response-body-unavailable", { requestId: params.requestId, requestKey: reqKey, reason: error.message || String(error) });
        await addRecord("responseBodyUnavailableGap", { requestId: params.requestId, requestKey: reqKey, target: target, reason: "response began before capture and its body could not be recovered" });
      }
    }
    return;
  }

  if (method === "Network.loadingFailed") {
    await addRecord("loadingFailed", { requestId: params.requestId, requestKey: requestKey(source, params.requestId), target: target, payload: params });
    return;
  }

  if (method === "Network.webSocketCreated" || method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived" || method === "Network.webSocketClosed") {
    await addRecord("webSocket", { event: method.slice("Network.".length), target: target, payload: params, interaction: correlationForNow() });
    return;
  }

  if (method === "Network.eventSourceMessageReceived") {
    await addRecord("eventSource", { target: target, payload: params, interaction: correlationForNow() });
    return;
  }

  if (method === "Debugger.scriptParsed") {
    var scriptMeta = {
      scriptId: params.scriptId,
      url: params.url || "",
      startLine: params.startLine,
      startColumn: params.startColumn,
      endLine: params.endLine,
      endColumn: params.endColumn,
      executionContextId: params.executionContextId,
      hash: params.hash || "",
      sourceMapURL: params.sourceMapURL || "",
      target: target
    };
    await addRecord("scriptParsed", scriptMeta);
    if (WebCaptrueTargets.isBrowserExtensionUrl(params.url || "")) {
      await addRecord("scriptSourceExcluded", { scriptId: params.scriptId, url: params.url || "", target: target, reason: "browser extension artifact outside webpage origin" });
      return;
    }
    try {
      var script = await command(debuggee, "Debugger.getScriptSource", { scriptId: params.scriptId });
      var sourceText = script.scriptSource || "";
      if (sourceText.length <= MAX_SCRIPT_BYTES) {
        await addRecord("scriptSource", { scriptId: params.scriptId, url: params.url || "", target: target, source: sourceText });
      } else {
        await addRecord("scriptSourceSkipped", { scriptId: params.scriptId, url: params.url || "", target: target, reason: "source exceeds 2 MB" });
      }
    } catch (error) {
      await addRecord("scriptSourceSkipped", { scriptId: params.scriptId, url: params.url || "", target: target, reason: error.message || String(error) });
    }
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    state.counters.console += 1;
    schedulePersist();
    await addRecord("console", { target: target, payload: params });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    state.counters.console += 1;
    schedulePersist();
    await addRecord("exception", { target: target, payload: params });
    return;
  }

  if (method === "Log.entryAdded") {
    state.counters.console += 1;
    schedulePersist();
    await addRecord("log", { target: target, entry: params.entry || params });
    return;
  }

  if (method === "Page.frameAttached") {
    if (!source.targetId && params.frameId) rootFrameIds.add(params.frameId);
    await addRecord("frameAttached", { target: target, frameId: params.frameId, parentFrameId: params.parentFrameId || "" });
    return;
  }

  if (method === "Page.frameDetached") {
    if (!source.targetId && params.frameId) rootFrameIds.delete(params.frameId);
    await addRecord("frameDetached", { target: target, frameId: params.frameId, reason: params.reason || "" });
    return;
  }

  if (method === "Page.frameNavigated") {
    if (!source.targetId && params.frame && params.frame.id) rootFrameIds.add(params.frame.id);
    if (params.frame && params.frame.url) {
      rememberAllowedOrigin(params.frame.url);
      rememberAllowedTargetUrl(params.frame.url);
    }
    await addRecord("navigation", { target: target, frame: params.frame || params });
    if (!source.targetId && params.frame && !params.frame.parentId) {
      setTimeout(function () { capturePageState("navigation"); }, 700);
      if (state.options.autoScreenshots) setTimeout(function () { captureVisibleScreenshot("navigation", false); }, 900);
    }
  }
}

chrome.debugger.onEvent.addListener(function (source, method, params) {
  lastDebuggerEventAt = Date.now();
  var queueKey = sourceKey(source);
  var previous = debuggerEventQueues.get(queueKey) || Promise.resolve();
  var pending = previous.catch(function () {}).then(function () {
    return handleDebuggerEvent(source, method, params || {});
  }).catch(function (error) {
    markCompletenessIssue("debugger-event-handling-failed", { source: sourceKey(source), method: method, reason: error.message || String(error) });
    return addRecord("eventHandlingFailed", { source: sourceKey(source), method: method, reason: error.message || String(error) });
  }).finally(function () {
    pendingDebuggerEvents.delete(pending);
    if (debuggerEventQueues.get(queueKey) === pending) debuggerEventQueues.delete(queueKey);
  });
  debuggerEventQueues.set(queueKey, pending);
  pendingDebuggerEvents.add(pending);
});

chrome.debugger.onDetach.addListener(function (source, reason) {
  var key = sourceKey(source);
  if (expectedDetachKeys.has(key)) return;
  if (source.targetId && capturedTargets.has(source.targetId)) {
    capturedTargets.delete(source.targetId);
    updateTargetCounter();
    addRecord("targetDetached", { targetId: source.targetId, reason: reason });
    schedulePersist();
    return;
  }
  if (state.active && !state.stopping && source.tabId === state.tabId) {
    state.lastError = "Debugger detached: " + reason;
    addRecord("debuggerDetached", { reason: reason }).then(function () {
      return exportInterruptedSession("debugger-detached:" + reason);
    }).catch(function () {});
    schedulePersist();
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (state.active && !state.stopping && tabId === state.tabId) {
    state.lastError = "Captured tab was closed";
    addRecord("tabClosed", {}).then(function () {
      return exportInterruptedSession("captured-tab-closed");
    }).catch(function () {});
    schedulePersist();
  }
});

self.addEventListener("error", function (event) {
  if (!state.sessionId) return;
  diagnosticLog("error", "service-worker", "unhandled-error", {
    error: errorDiagnostic(event && event.error || new Error(event && event.message || "Unhandled service worker error")),
    filename: event && event.filename || "",
    line: event && event.lineno,
    column: event && event.colno
  });
});

self.addEventListener("unhandledrejection", function (event) {
  if (!state.sessionId) return;
  var reason = event && event.reason;
  diagnosticLog("error", "service-worker", "unhandled-rejection", { error: errorDiagnostic(reason) });
});

chrome.commands.onCommand.addListener(function (commandName) {
  if (commandName !== "toggle-capture") return;
  Promise.resolve().then(async function () {
    if (state.active) {
      await stopCapture();
      return;
    }
    var tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") throw new Error("No active tab available for capture");
    await startCapture(tab.id, { captureBodies: true, autoScreenshots: true, captureClientStorage: true });
  }).catch(function (error) {
    state.lastError = "Capture shortcut failed: " + (error.message || String(error));
    markCompletenessIssue("capture-shortcut-failed", { reason: error.message || String(error) });
  });
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return false;
  if (message.target === "offscreen") return false;

  if (message.type === "KEEPALIVE") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PAGE_INTERACTION") {
    if (!state.active || !sender.tab || sender.tab.id !== state.tabId) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    state.counters.actions += 1;
    var interaction = Object.assign({}, message.interaction || {});
    interaction.interactionId = "act-" + Date.now() + "-" + state.counters.actions;
    interaction.frameId = typeof sender.frameId === "number" ? sender.frameId : null;
    var interactionTime = Date.parse(interaction.at || "");
    lastInteraction = {
      id: interaction.interactionId,
      kind: interaction.kind || "unknown",
      at: interaction.at || new Date().toISOString(),
      atMs: isFinite(interactionTime) ? interactionTime : Date.now()
    };
    schedulePersist();
    addRecord("interaction", interaction).then(function () {
      if (state.options.autoScreenshots && /^(click|submit|change)$/.test(interaction.kind || "")) {
        setTimeout(function () { captureVisibleScreenshot("action-" + interaction.kind, false); }, 250);
      }
    });
    sendResponse({ ok: true, interactionId: interaction.interactionId });
    return false;
  }

  Promise.resolve().then(async function () {
    if (message.type === "GET_STATUS") return { ok: true, state: cloneState() };
    if (message.type === "START_CAPTURE") return { ok: true, state: await startCapture(message.tabId, message.options || {}) };
    if (message.type === "TOGGLE_CAPTURE_FROM_PAGE") {
      if (!sender.tab || typeof sender.tab.id !== "number") return { ok: false, error: "Capture shortcut requires a normal webpage tab" };
      if (state.active) {
        if (sender.tab.id !== state.tabId) return { ok: false, error: "Another tab is currently being captured" };
        var stoppedByPage = await stopCapture();
        return { ok: true, state: stoppedByPage.state, filename: stoppedByPage.filename };
      }
      return { ok: true, state: await startCapture(sender.tab.id, { captureBodies: true, autoScreenshots: true, captureClientStorage: true }) };
    }
    if (message.type === "STOP_CAPTURE") {
      var result = await stopCapture();
      return { ok: true, state: result.state, filename: result.filename };
    }
    return { ok: false, error: "Unknown message: " + message.type };
  }).then(sendResponse).catch(async function (error) {
    if (state.sessionId) {
      await diagnosticLog("error", "messaging", "message-command-failed", {
        messageType: message.type,
        error: errorDiagnostic(error)
      });
    }
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(function () {
  var defaults = {};
  defaults[SETTINGS_KEY] = { captureBodies: true, autoScreenshots: true, captureClientStorage: true, maxBodyBytes: MAX_BODY_BYTES };
  chrome.storage.local.set(defaults, function () { void chrome.runtime.lastError; });
});

chromeStorageGet([STATE_KEY]).then(async function (saved) {
  var persisted = saved && saved[STATE_KEY];
  if (persisted) state = persisted;
  if (!state.diagnostics) state.diagnostics = freshState().diagnostics;
  if (state.active || state.recoverable) {
    state.active = false;
    state.stopping = false;
    state.recoverable = true;
    state.lastError = "Service worker restarted during or after an unfinished capture";
    markCompletenessIssue("service-worker-restarted", { recovery: "automatic interrupted-session export" });
    await diagnosticLog("warning", "service-worker", "service-worker-restarted", {
      recovery: "automatic interrupted-session export",
      counters: state.counters
    });
    try { await exportInterruptedSession("service-worker-restarted"); } catch (_) {}
  }
  schedulePersist();
});
