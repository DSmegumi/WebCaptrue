(function () {
  "use strict";

  var inputTimers = new WeakMap();
  var MAX_IDB_DATABASES = 20;
  var MAX_IDB_STORES = 50;
  var MAX_IDB_ROWS_PER_STORE = 150;
  var MAX_CACHE_NAMES = 20;
  var MAX_CACHE_ENTRIES = 150;
  var MAX_CACHE_TEXT_BYTES = 512 * 1024;

  function safeText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit || 160);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return "\\" + ch; });
  }

  function selectorFor(element) {
    if (!element || element.nodeType !== 1) return "";
    if (element.id) return "#" + cssEscape(element.id);
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      var part = node.tagName.toLowerCase();
      var testId = node.getAttribute("data-testid") || node.getAttribute("data-test");
      var name = node.getAttribute("name");
      if (testId) {
        part += '[data-testid="' + String(testId).replace(/"/g, "\\\"") + '"]';
        parts.unshift(part);
        break;
      }
      if (name && /^(input|select|textarea|button|form)$/.test(part)) {
        part += '[name="' + String(name).replace(/"/g, "\\\"") + '"]';
      } else if (node.parentElement) {
        var siblings = Array.prototype.filter.call(node.parentElement.children, function (x) { return x.tagName === node.tagName; });
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function detailsFor(target) {
    var data = {
      selector: selectorFor(target),
      tag: target && target.tagName ? target.tagName.toLowerCase() : "",
      text: safeText(target && (target.innerText || target.textContent), 180),
      name: target && target.getAttribute ? target.getAttribute("name") || "" : "",
      role: target && target.getAttribute ? target.getAttribute("role") || "" : ""
    };
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      var inputType = (target.getAttribute("type") || target.tagName).toLowerCase();
      data.inputType = inputType;
      data.value = "[REDACTED]";
      data.valueLength = typeof target.value === "string" ? target.value.length : 0;
      data.placeholder = target.getAttribute("placeholder") || "";
    }
    return data;
  }

  function emit(kind, target, extra) {
    try {
      chrome.runtime.sendMessage({
        type: "PAGE_INTERACTION",
        interaction: Object.assign({
          kind: kind,
          at: new Date().toISOString(),
          frameUrl: location.href,
          topFrame: window.top === window,
          target: detailsFor(target)
        }, extra || {})
      }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function isSensitiveKey(name) {
    return /(?:pass(?:word)?|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|session[_-]?id|authorization|cookie|api[_-]?key)/i.test(String(name || ""));
  }

  function headersToObject(headers) {
    var out = {};
    try {
      headers.forEach(function (value, name) {
        out[name] = /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name) ? "[REDACTED]" : value;
      });
    } catch (_) {}
    return out;
  }

  function jsonSafe(value, depth, seen, keyName) {
    if (isSensitiveKey(keyName)) return "[REDACTED]";
    if (value === null || value === undefined) return value === undefined ? null : value;
    if (depth > 7) return "[MAX_DEPTH]";
    var type = typeof value;
    if (type === "string") return value.length > 12000 ? value.slice(0, 12000) + "...[TRUNCATED]" : value;
    if (type === "number" || type === "boolean") return value;
    if (type === "bigint") return String(value);
    if (type === "function" || type === "symbol") return "[" + type + "]";
    if (value instanceof Date) return value.toISOString();
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return { _type: value instanceof File ? "File" : "Blob", name: value.name || "", size: value.size, mimeType: value.type || "" };
    }
    if (value instanceof ArrayBuffer) return { _type: "ArrayBuffer", byteLength: value.byteLength };
    if (ArrayBuffer.isView(value)) return { _type: value.constructor && value.constructor.name || "TypedArray", byteLength: value.byteLength };
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 500).map(function (item) { return jsonSafe(item, depth + 1, seen, ""); });
    }
    var out = {};
    try {
      Object.keys(value).slice(0, 500).forEach(function (key) {
        out[key] = jsonSafe(value[key], depth + 1, seen, key);
      });
    } catch (_) {
      return String(value);
    }
    return out;
  }

  function safeValue(value) {
    return jsonSafe(value, 0, new WeakSet(), "");
  }

  function dumpWebStorage(storage) {
    var out = {};
    try {
      for (var i = 0; i < storage.length; i += 1) {
        var key = storage.key(i);
        var value = storage.getItem(key);
        out[key] = isSensitiveKey(key) ? "[REDACTED]" : (String(value || "").length > 12000 ? String(value).slice(0, 12000) + "...[TRUNCATED]" : value);
      }
    } catch (error) {
      out._error = error.message || String(error);
    }
    return out;
  }

  function openDatabase(name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB open failed")); };
      req.onupgradeneeded = function () {
        try { req.transaction.abort(); } catch (_) {}
        reject(new Error("Database metadata became unavailable during capture"));
      };
    });
  }

  function readObjectStore(db, storeName) {
    return new Promise(function (resolve) {
      var result = { name: storeName, rows: [], truncated: false, indexes: [] };
      var tx;
      try {
        tx = db.transaction(storeName, "readonly");
        var store = tx.objectStore(storeName);
        result.keyPath = safeValue(store.keyPath);
        result.autoIncrement = !!store.autoIncrement;
        result.indexes = Array.prototype.map.call(store.indexNames || [], function (indexName) {
          try {
            var idx = store.index(indexName);
            return { name: idx.name, keyPath: safeValue(idx.keyPath), unique: !!idx.unique, multiEntry: !!idx.multiEntry };
          } catch (_) {
            return { name: indexName };
          }
        });
        var req = store.openCursor();
        req.onsuccess = function () {
          var cursor = req.result;
          if (!cursor) return;
          if (result.rows.length >= MAX_IDB_ROWS_PER_STORE) {
            result.truncated = true;
            return;
          }
          result.rows.push({ key: safeValue(cursor.key), primaryKey: safeValue(cursor.primaryKey), value: safeValue(cursor.value) });
          cursor.continue();
        };
        req.onerror = function () { result.error = req.error && req.error.message || "Cursor failed"; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { result.error = tx.error && tx.error.message || result.error || "Transaction failed"; resolve(result); };
        tx.onabort = function () { result.error = tx.error && tx.error.message || result.error || "Transaction aborted"; resolve(result); };
      } catch (error) {
        result.error = error.message || String(error);
        resolve(result);
      }
    });
  }

  async function dumpIndexedDB() {
    var result = { supported: !!(window.indexedDB && indexedDB.databases), databases: [] };
    if (!result.supported) {
      result.reason = "indexedDB.databases() unavailable";
      return result;
    }
    try {
      var infos = await indexedDB.databases();
      result.truncated = infos.length > MAX_IDB_DATABASES;
      infos = infos.slice(0, MAX_IDB_DATABASES);
      for (var i = 0; i < infos.length; i += 1) {
        if (!infos[i] || !infos[i].name) continue;
        var dbInfo = { name: infos[i].name, version: infos[i].version || null, objectStores: [] };
        try {
          var db = await openDatabase(infos[i].name);
          dbInfo.version = db.version;
          var names = Array.prototype.slice.call(db.objectStoreNames || []);
          dbInfo.truncated = names.length > MAX_IDB_STORES;
          names = names.slice(0, MAX_IDB_STORES);
          for (var j = 0; j < names.length; j += 1) dbInfo.objectStores.push(await readObjectStore(db, names[j]));
          db.close();
        } catch (error) {
          dbInfo.error = error.message || String(error);
        }
        result.databases.push(dbInfo);
      }
    } catch (error) {
      result.error = error.message || String(error);
    }
    return result;
  }

  function textLikeMime(mime) {
    var value = String(mime || "").toLowerCase();
    return value.indexOf("text/") === 0 || /(?:json|javascript|xml|graphql|x-www-form-urlencoded)/.test(value);
  }

  function sanitizeTextPayload(text, mime) {
    if (!text) return text;
    if (String(mime || "").toLowerCase().indexOf("json") >= 0 || /^[\s]*[\[{]/.test(text)) {
      try { return JSON.stringify(safeValue(JSON.parse(text))); } catch (_) {}
    }
    return String(text)
      .replace(/((?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)\s*[=:]\s*)[^&\s,;]+/ig, "$1[REDACTED]")
      .replace(/("(?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)"\s*:\s*")[^"]*(")/ig, "$1[REDACTED]$2");
  }

  async function dumpCacheStorage() {
    var result = { supported: typeof caches !== "undefined", caches: [] };
    if (!result.supported) return result;
    try {
      var names = await caches.keys();
      result.truncated = names.length > MAX_CACHE_NAMES;
      names = names.slice(0, MAX_CACHE_NAMES);
      for (var i = 0; i < names.length; i += 1) {
        var cache = await caches.open(names[i]);
        var requests = await cache.keys();
        var cacheInfo = { name: names[i], entries: [], truncated: requests.length > MAX_CACHE_ENTRIES };
        var limited = requests.slice(0, MAX_CACHE_ENTRIES);
        for (var j = 0; j < limited.length; j += 1) {
          var req = limited[j];
          var response = await cache.match(req);
          var entry = {
            request: { method: req.method, url: req.url, headers: headersToObject(req.headers) },
            response: response ? { status: response.status, statusText: response.statusText, type: response.type, headers: headersToObject(response.headers) } : null
          };
          if (response) {
            var mime = response.headers.get("content-type") || "";
            var declared = parseInt(response.headers.get("content-length") || "0", 10);
            if (textLikeMime(mime) && (!declared || declared <= MAX_CACHE_TEXT_BYTES)) {
              try {
                var text = await response.clone().text();
                if (text.length <= MAX_CACHE_TEXT_BYTES) entry.response.body = sanitizeTextPayload(text, mime);
                else entry.response.bodySkipped = "text exceeds 1 MB";
              } catch (error) {
                entry.response.bodySkipped = error.message || String(error);
              }
            } else {
              entry.response.bodySkipped = textLikeMime(mime) ? "declared content length exceeds 1 MB" : "binary/non-text body";
            }
          }
          cacheInfo.entries.push(entry);
        }
        result.caches.push(cacheInfo);
      }
    } catch (error) {
      result.error = error.message || String(error);
    }
    return result;
  }

  async function collectClientStorage(label) {
    var local = {};
    var session = {};
    try { local = dumpWebStorage(window.localStorage); } catch (error) { local = { _error: error.message || String(error) }; }
    try { session = dumpWebStorage(window.sessionStorage); } catch (error2) { session = { _error: error2.message || String(error2) }; }
    var snapshot = {
      label: label || "snapshot",
      capturedAt: new Date().toISOString(),
      frameUrl: location.href,
      origin: location.origin,
      topFrame: window.top === window,
      localStorage: local,
      sessionStorage: session,
      indexedDB: null,
      cacheStorage: null
    };
    snapshot.indexedDB = await dumpIndexedDB();
    snapshot.cacheStorage = await dumpCacheStorage();
    return snapshot;
  }

  document.addEventListener("click", function (event) {
    emit("click", event.target);
  }, true);

  document.addEventListener("submit", function (event) {
    emit("submit", event.target);
  }, true);

  document.addEventListener("change", function (event) {
    emit("change", event.target);
  }, true);

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    var old = inputTimers.get(target);
    if (old) clearTimeout(old);
    inputTimers.set(target, setTimeout(function () {
      emit("input", target);
      inputTimers.delete(target);
    }, 500));
  }, true);

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "REQUEST_CLIENT_STORAGE") return false;
    collectClientStorage(message.label).then(function (snapshot) {
      sendResponse({ ok: true, snapshot: snapshot });
    }).catch(function (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  });
}());
