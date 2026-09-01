"use strict";

// Response-body capture sizing policy.
// 0 stored in settings means no extension-side per-response limit.
var DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;
var CDP_MAX_TOTAL_BUFFER_BYTES = 512 * 1024 * 1024;
var CDP_MAX_RESOURCE_BUFFER_BYTES = 256 * 1024 * 1024;
var LEGACY_MAX_BODY_BYTES = 5 * 1024 * 1024;

MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

function applyConfiguredBodyLimit(value) {
  if (value === 0 || value === "0" || value === null) {
    MAX_BODY_BYTES = Infinity;
    return;
  }
  var numeric = Number(value);
  MAX_BODY_BYTES = Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_MAX_BODY_BYTES;
}

chromeStorageGet([SETTINGS_KEY]).then(function (saved) {
  var settings = saved && saved[SETTINGS_KEY];
  if (!settings) return;
  // Existing installs used 5 MiB as an implicit default. Migrate that default
  // to 128 MiB while preserving any explicit custom value.
  if (settings.maxBodyBytes === LEGACY_MAX_BODY_BYTES) {
    settings.maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
    var migrated = {};
    migrated[SETTINGS_KEY] = settings;
    chrome.storage.local.set(migrated, function () { void chrome.runtime.lastError; });
  }
  applyConfiguredBodyLimit(settings.maxBodyBytes);
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) return;
  var settings = changes[SETTINGS_KEY].newValue || {};
  applyConfiguredBodyLimit(settings.maxBodyBytes);
});

// Preserve the existing command wrapper while supplying larger CDP Network
// buffers. This reduces the chance that Chrome discards a large response body
// before WebCaptrue asks for it.
var webCaptrueBaseCommand = command;
command = function (debuggee, method, params) {
  if (method === "Network.enable") {
    params = Object.assign({}, params || {}, {
      maxTotalBufferSize: CDP_MAX_TOTAL_BUFFER_BYTES,
      maxResourceBufferSize: CDP_MAX_RESOURCE_BUFFER_BYTES,
      maxPostDataSize: DEFAULT_MAX_BODY_BYTES
    });
  }
  return webCaptrueBaseCommand(debuggee, method, params);
};
