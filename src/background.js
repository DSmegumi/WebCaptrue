importScripts("lib/db.js");

(function () {
  "use strict";

  var PROTOCOL_VERSION = "1.3";
  var MAX_BODY_BYTES = 5 * 1024 * 1024;
  var STATE_KEY = "webcaptrueRuntimeState";
  var SETTINGS_KEY = "webcaptrueSettings";
  var db = new WebCaptrueDB();
  var requestMap = new Map();
  var lastScreenshotAt = 0;
  var persistTimer = null;
  var expectedDetach = false;

  var state = freshState();

  function freshCounters() {
    return { requests: 0, responses: 0, apis: 0, actions: 0, console: 0, screenshots: 0 };
  }

  function freshState() {
    return {
      active: false,
      sessionId: null,
      tabId: null,
      startedAt: null,
      url: null,
      title: null,
      options: { captureBodies: true, autoScreenshots: true },
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

  function chromeStorageSet(value) {
    return new Promise(function (resolve) { chrome.storage.local.set(value, resolve); });
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

  function command(debuggee, method, params) {
    return new Promise(function (resolve, reject) {
      chrome.debugger.sendCommand(debuggee, method, params || {}, function (result) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result || {});
      });
    });
  }

  function getTab(tabId) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.get(tabId, function (tab) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab);
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
    if (mime.indexOf("json") >= 0 || /^[\s]*[\[{]/.test(text)) {
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
    } catch (_) {}
    try {
      var storage = await command(debuggee, "Runtime.evaluate", {
        expression: "(function(){var re=/(pass(?:word)?|passwd|pwd|token|secret|session|auth|cookie|api[_-]?key)/i;function dump(s){var o={};for(var i=0;i<s.length;i++){var k=s.key(i);var v=s.getItem(k);o[k]=re.test(k)?\"[REDACTED]\":v;}return o;}return JSON.stringify({localStorage:dump(localStorage),sessionStorage:dump(sessionStorage)});}())",
        returnByValue: true
      });
      var value = storage.result && storage.result.value;
      await addRecord("storageSnapshot", { label: label, value: value ? JSON.parse(value) : {} });
    } catch (_) {}
  }

  async function captureScreenshot(label, force) {
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
      await addRecord("screenshot", { label: label, dataUrl: dataUrl });
    } catch (_) {}
  }

  async function captureExistingResources() {
    if (!state.active || typeof state.tabId !== "number") return;
    var debuggee = { tabId: state.tabId };
    var tree;
    try {
      tree = await command(debuggee, "Page.getResourceTree");
    } catch (_) {
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
      autoScreenshots: !options || options.autoScreenshots !== false
    };
    requestMap.clear();
    lastScreenshotAt = 0;
    expectedDetach = false;
    await db.clearSession(sessionId);
    try {
      await command(debuggee, "Network.enable");
      await command(debuggee, "Runtime.enable");
      await command(debuggee, "Log.enable");
      await command(debuggee, "Page.enable");
      await command(debuggee, "Debugger.enable");
    } catch (error) {
      state.active = false;
      expectedDetach = true;
      await debuggerDetach(debuggee);
      expectedDetach = false;
      throw error;
    }
    await addRecord("sessionStart", { url: state.url, title: state.title, options: state.options, userAgent: navigator.userAgent });
    schedulePersist();
    await captureExistingResources();
    await capturePageState("start");
    await captureScreenshot("start", true);
    return cloneState();
  }

  async function stopCapture() {
    if (!state.active) return { state: cloneState(), filename: null };
    var stoppedState;
    var sessionId = state.sessionId;
    var debuggee = { tabId: state.tabId };

    await capturePageState("final");
    await captureScreenshot("final", true);
    await addRecord("sessionStop", { stoppedAt: new Date().toISOString(), counters: state.counters });
    expectedDetach = true;
    await debuggerDetach(debuggee);
    expectedDetach = false;

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

  async function handleDebuggerEvent(source, method, params) {
    if (!state.active || source.tabId !== state.tabId) return;
    if (method === "Network.requestWillBeSent") {
      var req = params.request || {};
      var rec = {
        requestId: params.requestId,
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
        initiator: params.initiator || null
      };
      requestMap.set(params.requestId, rec);
      state.counters.requests += 1;
      if (isApiType(params.type)) state.counters.apis += 1;
      schedulePersist();
      await addRecord("request", rec);
      return;
    }

    if (method === "Network.requestWillBeSentExtraInfo") {
      await addRecord("requestExtraInfo", {
        requestId: params.requestId,
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
        timing: res.timing || null
      };
      var known = requestMap.get(params.requestId) || {};
      known.response = responseRec;
      requestMap.set(params.requestId, known);
      state.counters.responses += 1;
      schedulePersist();
      await addRecord("response", responseRec);
      return;
    }

    if (method === "Network.loadingFinished") {
      if (!state.options.captureBodies) return;
      var knownRequest = requestMap.get(params.requestId) || {};
      if (params.encodedDataLength > MAX_BODY_BYTES) {
        await addRecord("responseBodySkipped", { requestId: params.requestId, reason: "encodedDataLength exceeds limit", encodedDataLength: params.encodedDataLength });
        return;
      }
      try {
        var body = await command({ tabId: state.tabId }, "Network.getResponseBody", { requestId: params.requestId });
        var responseMime = (knownRequest.response && knownRequest.response.mimeType) || "";
        var bodyText = body.body || "";
        var approximateBodyBytes = body.base64Encoded ? Math.floor(bodyText.length * 0.75) : bodyText.length;
        if (approximateBodyBytes > MAX_BODY_BYTES) {
          await addRecord("responseBodySkipped", { requestId: params.requestId, reason: "decoded body exceeds limit", approximateBytes: approximateBodyBytes });
          return;
        }
        await addRecord("responseBody", {
          requestId: params.requestId,
          url: (knownRequest.response && knownRequest.response.url) || knownRequest.url || "",
          mimeType: responseMime,
          resourceType: knownRequest.resourceType || "",
          base64Encoded: !!body.base64Encoded,
          body: body.base64Encoded ? bodyText : sanitizePayload(bodyText, responseMime)
        });
      } catch (error) {
        await addRecord("responseBodySkipped", { requestId: params.requestId, reason: error.message || String(error) });
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      await addRecord("loadingFailed", params);
      return;
    }

    if (method === "Network.webSocketCreated" || method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived" || method === "Network.webSocketClosed") {
      await addRecord("webSocket", { event: method.slice("Network.".length), payload: params });
      return;
    }

    if (method === "Network.eventSourceMessageReceived") {
      await addRecord("eventSource", params);
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
        sourceMapURL: params.sourceMapURL || ""
      };
      await addRecord("scriptParsed", scriptMeta);
      try {
        var script = await command({ tabId: state.tabId }, "Debugger.getScriptSource", { scriptId: params.scriptId });
        var sourceText = script.scriptSource || "";
        if (sourceText.length <= 2 * 1024 * 1024) {
          await addRecord("scriptSource", { scriptId: params.scriptId, url: params.url || "", source: sourceText });
        } else {
          await addRecord("scriptSourceSkipped", { scriptId: params.scriptId, url: params.url || "", reason: "source exceeds 2 MB" });
        }
      } catch (_) {}
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      state.counters.console += 1;
      schedulePersist();
      await addRecord("console", params);
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      state.counters.console += 1;
      schedulePersist();
      await addRecord("exception", params);
      return;
    }

    if (method === "Log.entryAdded") {
      state.counters.console += 1;
      schedulePersist();
      await addRecord("log", params.entry || params);
      return;
    }

    if (method === "Page.frameNavigated") {
      await addRecord("navigation", params.frame || params);
      if (params.frame && !params.frame.parentId) {
        setTimeout(function () { capturePageState("navigation"); }, 700);
        if (state.options.autoScreenshots) setTimeout(function () { captureScreenshot("navigation", false); }, 900);
      }
    }
  }

  chrome.debugger.onEvent.addListener(function (source, method, params) {
    handleDebuggerEvent(source, method, params || {}).catch(function () {});
  });

  chrome.debugger.onDetach.addListener(function (source, reason) {
    if (expectedDetach && source.tabId === state.tabId) return;
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
      schedulePersist();
      addRecord("interaction", message.interaction || {}).then(function () {
        if (state.options.autoScreenshots && message.interaction && /^(click|submit|change)$/.test(message.interaction.kind)) {
          setTimeout(function () { captureScreenshot("action-" + message.interaction.kind, false); }, 250);
        }
      });
      sendResponse({ ok: true });
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
    defaults[SETTINGS_KEY] = { captureBodies: true, autoScreenshots: true, maxBodyBytes: MAX_BODY_BYTES };
    chrome.storage.local.set(defaults, function () { void chrome.runtime.lastError; });
  });

  chromeStorageGet([STATE_KEY]).then(function (saved) {
    if (saved && saved[STATE_KEY] && !saved[STATE_KEY].active) state = saved[STATE_KEY];
    if (state.active) state = freshState();
    schedulePersist();
  });
}());
