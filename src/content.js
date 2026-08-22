(function () {
  "use strict";

  var inputTimers = new WeakMap();

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
}());
