(function (global) {
  "use strict";

  var CAPTURABLE_TYPES = {
    iframe: true,
    worker: true,
    shared_worker: true,
    service_worker: true
  };

  function chromeMajor(userAgent) {
    var match = String(userAgent || "").match(/(?:Chrome|Chromium)\/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function supportsFlatSessions(userAgent) {
    return chromeMajor(userAgent) >= 125;
  }

  function normalize(info) {
    info = info || {};
    return {
      targetId: info.targetId || info.id || "",
      type: String(info.type || ""),
      url: String(info.url || ""),
      title: String(info.title || ""),
      tabId: typeof info.tabId === "number" ? info.tabId : null,
      attached: !!info.attached,
      parentId: info.parentId || "",
      openerId: info.openerId || "",
      parentFrameId: info.parentFrameId || ""
    };
  }

  function originForUrl(value) {
    try { return new URL(String(value || "")).origin; } catch (_) { return ""; }
  }

  function isCapturableType(type) {
    return !!CAPTURABLE_TYPES[String(type || "")];
  }

  function isBrowserExtensionUrl(value) {
    return /^chrome-extension:\/\//i.test(String(value || ""));
  }

  function isFallbackCandidate(rawInfo, scope) {
    var info = normalize(rawInfo);
    scope = scope || {};
    if (!info.targetId || info.targetId === scope.rootTargetId) return false;
    if (!isCapturableType(info.type)) return false;
    if (typeof info.tabId === "number" && typeof scope.rootTabId === "number" && info.tabId === scope.rootTabId) return true;
    var origin = originForUrl(info.url);
    if (!origin || (scope.allowedOrigins || []).indexOf(origin) < 0) return false;
    if (info.type === "shared_worker" || info.type === "service_worker") return true;
    return (scope.allowedUrls || []).indexOf(info.url) >= 0;
  }

  global.WebCaptrueTargets = {
    chromeMajor: chromeMajor,
    supportsFlatSessions: supportsFlatSessions,
    normalize: normalize,
    originForUrl: originForUrl,
    isCapturableType: isCapturableType,
    isBrowserExtensionUrl: isBrowserExtensionUrl,
    isFallbackCandidate: isFallbackCandidate
  };
}(typeof self !== "undefined" ? self : window));
