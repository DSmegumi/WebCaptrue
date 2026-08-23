(function (global) {
  "use strict";

  function isSensitiveKey(name) {
    return /(?:pass(?:word)?|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|session[_-]?id|authorization|cookie|api[_-]?key)/i.test(String(name || ""));
  }

  function note(audit, category, path) {
    if (audit) audit.push({ category: category, path: path || "" });
  }

  function structuredValue(value, keyName, audit, path) {
    if (isSensitiveKey(keyName)) {
      note(audit, "sensitive-field", path);
      return "[REDACTED]";
    }
    if (Array.isArray(value)) return value.map(function (item, index) { return structuredValue(item, "", audit, (path || "$") + "[" + index + "]"); });
    if (value && typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (key) { out[key] = structuredValue(value[key], key, audit, (path || "$") + "." + key); });
      return out;
    }
    if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
      try { return JSON.stringify(structuredValue(JSON.parse(value), "", audit, path)); } catch (_) {}
    }
    return value;
  }

  function storageValue(key, value) {
    if (isSensitiveKey(key)) return "[REDACTED]";
    var text = String(value === null || value === undefined ? "" : value);
    if (/^[\s]*[\[{]/.test(text)) {
      try { return JSON.stringify(structuredValue(JSON.parse(text), "")); } catch (_) {}
    }
    return text;
  }

  function sourceText(value, audit, path) {
    return String(value || "").replace(/((?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization)\s*[=:]\s*)(["'])(.*?)\2/ig, function (_, prefix, quote) {
      note(audit, "source-literal", path);
      return prefix + quote + "[REDACTED]" + quote;
    });
  }

  function sanitizeJsonString(value, audit, path) {
    var text = String(value || "");
    if (!/^[\s]*[\[{]/.test(text)) return text;
    try { return JSON.stringify(structuredValue(JSON.parse(text), "", audit, path)); } catch (_) { return text; }
  }

  function headers(value, audit, path) {
    var out = {};
    Object.keys(value || {}).forEach(function (name) {
      if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)) {
        out[name] = "[REDACTED]";
        note(audit, "sensitive-header", (path || "$") + "." + name);
      } else {
        out[name] = value[name];
      }
    });
    return out;
  }

  function payloadText(value, contentType, audit, path) {
    var text = String(value || "");
    var mime = String(contentType || "").toLowerCase();
    if (mime.indexOf("json") >= 0 || /^[\s]*[\[{]/.test(text)) return sanitizeJsonString(text, audit, path);
    if (mime.indexOf("application/x-www-form-urlencoded") >= 0) {
      try {
        var params = new URLSearchParams(text);
        Array.from(params.keys()).forEach(function (key) {
          if (!isSensitiveKey(key)) return;
          params.set(key, "[REDACTED]");
          note(audit, "sensitive-form-field", (path || "$") + "." + key);
        });
        return params.toString();
      } catch (_) {}
    }
    return sourceText(text, audit, path);
  }

  function isTextMime(contentType) {
    return /^(?:text\/)|(?:json|javascript|xml|html|svg|x-www-form-urlencoded)/i.test(String(contentType || ""));
  }

  function decodeBase64Text(value) {
    var binary = atob(String(value || ""));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  function encodeBase64Text(value) {
    var bytes = new TextEncoder().encode(String(value || ""));
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64Payload(data, audit, path) {
    if (!data || !data.base64Encoded || !isTextMime(data.mimeType)) return;
    try {
      var decoded = decodeBase64Text(data.body);
      var sanitized = payloadText(decoded, data.mimeType, audit, path);
      if (sanitized !== decoded) data.body = encodeBase64Text(sanitized);
    } catch (_) {
      note(audit, "base64-text-redaction-skipped-non-utf8", path);
    }
  }

  function redactCookieRecords(data, audit, path) {
    (data.associatedCookies || []).forEach(function (item, index) {
      if (item.cookie && Object.prototype.hasOwnProperty.call(item.cookie, "value")) {
        item.cookie.value = "[REDACTED]";
        note(audit, "cookie-value", (path || "$") + ".associatedCookies[" + index + "].cookie.value");
      }
    });
  }

  function replaceSensitiveValues(value, sensitiveValues, audit, path) {
    var output = String(value || "");
    (sensitiveValues || []).forEach(function (sensitiveValue) {
      if (sensitiveValue.length < 4 || output.indexOf(sensitiveValue) < 0) return;
      output = output.split(sensitiveValue).join("[REDACTED]");
      note(audit, "password-value", path);
    });
    return output;
  }

  function runtimeValue(value, audit, path, sensitiveValues) {
    if (Array.isArray(value)) return value.map(function (item, index) { return runtimeValue(item, audit, (path || "$") + "[" + index + "]", sensitiveValues); });
    if (value && typeof value === "object") {
      var out = {};
      var sensitiveNamedValue = isSensitiveKey(value.name) && Object.prototype.hasOwnProperty.call(value, "value");
      Object.keys(value).forEach(function (key) {
        if (sensitiveNamedValue && key === "value") {
          note(audit, "runtime-named-value", (path || "$") + ".value");
          out[key] = "[REDACTED]";
        } else {
          out[key] = runtimeValue(value[key], audit, (path || "$") + "." + key, sensitiveValues);
        }
      });
      return out;
    }
    if (typeof value === "string") return sanitizeJsonString(replaceSensitiveValues(value, sensitiveValues, audit, path), audit, path);
    return value;
  }

  function html(value, audit, path) {
    var text = String(value || "");
    if (typeof DOMParser === "undefined") return text;
    try {
      var doc = new DOMParser().parseFromString(text, "text/html");
      Array.prototype.forEach.call(doc.querySelectorAll('input[type="password"]'), function (input) {
        if (input.hasAttribute("value")) {
          input.setAttribute("value", "[REDACTED]");
          note(audit, "password-input", path);
        }
      });
      Array.prototype.forEach.call(doc.querySelectorAll("body *"), function (element) {
        if (element.children.length) return;
        var sanitized = sanitizeJsonString(element.textContent, audit, path);
        if (sanitized !== element.textContent) element.textContent = sanitized;
      });
      return "<!doctype html>\n" + doc.documentElement.outerHTML;
    } catch (_) {
      return text;
    }
  }

  function domSnapshot(value, audit, path) {
    var snapshot = JSON.parse(JSON.stringify(value || {}));
    var strings = snapshot.strings || [];
    (snapshot.documents || []).forEach(function (document, documentIndex) {
      var nodes = document.nodes || {};
      var passwordNodeIndexes = {};
      (nodes.attributes || []).forEach(function (attributes, nodeIndex) {
        for (var i = 0; i < (attributes || []).length; i += 2) {
          if (String(strings[attributes[i]] || "").toLowerCase() === "type" && String(strings[attributes[i + 1]] || "").toLowerCase() === "password") passwordNodeIndexes[nodeIndex] = true;
        }
      });
      var inputValues = nodes.inputValue || {};
      (inputValues.index || []).forEach(function (nodeIndex, position) {
        if (!passwordNodeIndexes[nodeIndex]) return;
        var stringIndex = inputValues.value && inputValues.value[position];
        if (typeof stringIndex === "number") {
          strings[stringIndex] = "[REDACTED]";
          note(audit, "password-input", (path || "$") + ".documents[" + documentIndex + "]");
        }
      });
    });
    for (var i = 0; i < strings.length; i += 1) strings[i] = sanitizeJsonString(strings[i], audit, (path || "$") + ".strings[" + i + "]");
    return snapshot;
  }

  function passwordValuesFromSnapshot(value) {
    var snapshot = value || {};
    var strings = snapshot.strings || [];
    var values = [];
    (snapshot.documents || []).forEach(function (document) {
      var nodes = document.nodes || {};
      var passwordNodeIndexes = {};
      (nodes.attributes || []).forEach(function (attributes, nodeIndex) {
        for (var i = 0; i < (attributes || []).length; i += 2) {
          if (String(strings[attributes[i]] || "").toLowerCase() === "type" && String(strings[attributes[i + 1]] || "").toLowerCase() === "password") passwordNodeIndexes[nodeIndex] = true;
        }
      });
      var inputValues = nodes.inputValue || {};
      (inputValues.index || []).forEach(function (nodeIndex, position) {
        if (!passwordNodeIndexes[nodeIndex]) return;
        var stringIndex = inputValues.value && inputValues.value[position];
        var passwordValue = typeof stringIndex === "number" ? String(strings[stringIndex] || "") : "";
        if (passwordValue.length >= 4 && values.indexOf(passwordValue) < 0) values.push(passwordValue);
      });
    });
    return values;
  }

  function exportRecords(records) {
    var audit = [];
    var sensitiveValues = [];
    (records || []).forEach(function (record) {
      if (record.type !== "domStructuredSnapshot" || !record.data) return;
      passwordValuesFromSnapshot(record.data.snapshot).forEach(function (value) { if (sensitiveValues.indexOf(value) < 0) sensitiveValues.push(value); });
    });
    var output = (records || []).map(function (record, index) {
      var copy = runtimeValue(record, audit, "$[" + index + "]", sensitiveValues);
      var dataPath = "$[" + index + "].data";
      if (copy.type === "request" && copy.data) {
        copy.data.headers = headers(copy.data.headers, audit, dataPath + ".headers");
        if (copy.data.postData) copy.data.postData = payloadText(copy.data.postData, copy.data.headers && (copy.data.headers["Content-Type"] || copy.data.headers["content-type"]), audit, dataPath + ".postData");
      }
      if ((copy.type === "response" || copy.type === "requestExtraInfo" || copy.type === "responseExtraInfo") && copy.data) copy.data.headers = headers(copy.data.headers, audit, dataPath + ".headers");
      if (copy.type === "requestExtraInfo" && copy.data) redactCookieRecords(copy.data, audit, dataPath);
      if (copy.type === "responseBody" && copy.data) {
        if (copy.data.base64Encoded) base64Payload(copy.data, audit, dataPath + ".body");
        else copy.data.body = payloadText(copy.data.body, copy.data.mimeType, audit, dataPath + ".body");
      }
      if (copy.type === "clientStorageSnapshot" && copy.data && copy.data.snapshot) copy.data.snapshot = structuredValue(copy.data.snapshot, "", audit, dataPath + ".snapshot");
      if (copy.type === "scriptSource" && copy.data) copy.data.source = sourceText(copy.data.source, audit, "$[" + index + "].data.source");
      if (copy.type === "preloadedResource" && copy.data) {
        if (copy.data.base64Encoded) base64Payload(copy.data, audit, dataPath + ".body");
        else copy.data.body = payloadText(copy.data.body, copy.data.mimeType, audit, dataPath + ".body");
      }
      if (copy.type === "domSnapshot" && copy.data) copy.data.html = html(copy.data.html, audit, "$[" + index + "].data.html");
      if (copy.type === "domStructuredSnapshot" && copy.data) copy.data.snapshot = domSnapshot(copy.data.snapshot, audit, "$[" + index + "].data.snapshot");
      return copy;
    });
    return { records: output, redactions: audit };
  }

  global.WebCaptrueSanitize = {
    isSensitiveKey: isSensitiveKey,
    structuredValue: structuredValue,
    storageValue: storageValue,
    headers: headers,
    payloadText: payloadText,
    sourceText: sourceText,
    domSnapshot: domSnapshot,
    passwordValuesFromSnapshot: passwordValuesFromSnapshot,
    exportRecords: exportRecords
  };
}(typeof self !== "undefined" ? self : window));
