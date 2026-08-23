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
      if (copy.type === "scriptSource" && copy.data) copy.data.source = sourceText(copy.data.source, audit, "$[" + index + "].data.source");
      if (copy.type === "preloadedResource" && copy.data && (copy.data.resourceType === "Script" || /javascript/i.test(copy.data.mimeType || ""))) copy.data.body = sourceText(copy.data.body, audit, "$[" + index + "].data.body");
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
    sourceText: sourceText,
    domSnapshot: domSnapshot,
    passwordValuesFromSnapshot: passwordValuesFromSnapshot,
    exportRecords: exportRecords
  };
}(typeof self !== "undefined" ? self : window));
