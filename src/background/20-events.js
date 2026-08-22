"use strict";

async function handleDebuggerEvent(source, method, params) {
  if (!state.active || !isCapturedSource(source)) return;
  var debuggee = debuggeeForSource(source);
  var target = targetDescriptor(source);

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
        state.counters.targets = capturedTargets.size;
        schedulePersist();
        await addRecord("targetDestroyed", { targetId: destroyedId });
      }
    }
    return;
  }

  if (method === "Network.requestWillBeSent") {
    var req = params.request || {};
    var correlation = correlationForNow();
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
      headers: redactHeaders(req.headers),
      postData: req.hasPostData ? sanitizePayload(req.postData || "[POST DATA NOT AVAILABLE]", (req.headers && (req.headers["Content-Type"] || req.headers["content-type"])) || "") : null,
      initiator: params.initiator || null,
      target: target,
      interaction: correlation
    };
    requestMap.set(rec.requestKey, rec);
    state.counters.requests += 1;
    if (isApiType(params.type)) state.counters.apis += 1;
    schedulePersist();
    await addRecord("request", rec);
    return;
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    await addRecord("requestExtraInfo", {
      requestId: params.requestId,
      requestKey: requestKey(source, params.requestId),
      target: target,
      headers: redactHeaders(params.headers || {}),
      associatedCookies: (params.associatedCookies || []).map(function (item) {
        return { blockedReasons: item.blockedReasons || [], cookie: item.cookie ? { name: item.cookie.name, value: "[REDACTED]", domain: item.cookie.domain, path: item.cookie.path } : null };
      })
    });
    return;
  }

  if (method === "Network.responseReceivedExtraInfo") {
    await addRecord("responseExtraInfo", {
      requestId: params.requestId,
      requestKey: requestKey(source, params.requestId),
      target: target,
      statusCode: params.statusCode,
      headers: redactHeaders(params.headers || {}),
      blockedCookies: (params.blockedCookies || []).map(function (item) { return { blockedReasons: item.blockedReasons || [] }; })
    });
    return;
  }

  if (method === "Network.responseReceived") {
    var res = params.response || {};
    var responseRec = {
      requestId: params.requestId,
      requestKey: requestKey(source, params.requestId),
      resourceType: params.type,
      timestamp: params.timestamp,
      url: res.url,
      status: res.status,
      statusText: res.statusText,
      mimeType: res.mimeType,
      protocol: res.protocol,
      remoteIPAddress: res.remoteIPAddress,
      remotePort: res.remotePort,
      fromDiskCache: !!res.fromDiskCache,
      fromServiceWorker: !!res.fromServiceWorker,
      headers: redactHeaders(res.headers),
      timing: res.timing || null,
      target: target
    };
    var knownKey = requestKey(source, params.requestId);
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
        body: body.base64Encoded ? bodyText : sanitizePayload(bodyText, responseMime)
      });
    } catch (error) {
      await addRecord("responseBodySkipped", { requestId: params.requestId, requestKey: reqKey, target: target, reason: error.message || String(error) });
    }
    return;
  }

  if (method === "Network.loadingFailed") {
    await addRecord("loadingFailed", { target: target, payload: params });
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
    try {
      var script = await command(debuggee, "Debugger.getScriptSource", { scriptId: params.scriptId });
      var sourceText = script.scriptSource || "";
      if (sourceText.length <= MAX_SCRIPT_BYTES) {
        await addRecord("scriptSource", { scriptId: params.scriptId, url: params.url || "", target: target, source: sourceText });
      } else {
        await addRecord("scriptSourceSkipped", { scriptId: params.scriptId, url: params.url || "", target: target, reason: "source exceeds 2 MB" });
      }
    } catch (_) {}
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
    await addRecord("navigation", { target: target, frame: params.frame || params });
    if (!source.targetId && params.frame && !params.frame.parentId) {
      setTimeout(function () { capturePageState("navigation"); }, 700);
      if (state.options.autoScreenshots) setTimeout(function () { captureVisibleScreenshot("navigation", false); }, 900);
    }
  }
}

chrome.debugger.onEvent.addListener(function (source, method, params) {
  handleDebuggerEvent(source, method, params || {}).catch(function () {});
});

chrome.debugger.onDetach.addListener(function (source, reason) {
  var key = sourceKey(source);
  if (expectedDetachKeys.has(key)) return;
  if (source.targetId && capturedTargets.has(source.targetId)) {
    capturedTargets.delete(source.targetId);
    state.counters.targets = capturedTargets.size;
    addRecord("targetDetached", { targetId: source.targetId, reason: reason });
    schedulePersist();
    return;
  }
  if (state.active && source.tabId === state.tabId) {
    state.active = false;
    state.lastError = "Debugger detached: " + reason;
    addRecord("debuggerDetached", { reason: reason });
    schedulePersist();
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (state.active && tabId === state.tabId) {
    state.active = false;
    state.lastError = "Captured tab was closed";
    addRecord("tabClosed", {});
    schedulePersist();
  }
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
    if (message.type === "STOP_CAPTURE") {
      var result = await stopCapture();
      return { ok: true, state: result.state, filename: result.filename };
    }
    return { ok: false, error: "Unknown message: " + message.type };
  }).then(sendResponse).catch(function (error) {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(function () {
  var defaults = {};
  defaults[SETTINGS_KEY] = { captureBodies: true, autoScreenshots: true, captureClientStorage: true, maxBodyBytes: MAX_BODY_BYTES };
  chrome.storage.local.set(defaults, function () { void chrome.runtime.lastError; });
});

chromeStorageGet([STATE_KEY]).then(function (saved) {
  if (saved && saved[STATE_KEY] && !saved[STATE_KEY].active) state = saved[STATE_KEY];
  if (state.active) state = freshState();
  schedulePersist();
});
