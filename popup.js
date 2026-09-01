(function () {
  "use strict";

  var SETTINGS_KEY = "webcatrueSettings";
  var DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;
  var primary = document.getElementById("primary");
  var badge = document.getElementById("badge");
  var target = document.getElementById("target");
  var message = document.getElementById("message");
  var captureBodies = document.getElementById("captureBodies");
  var maxBodyBytes = document.getElementById("maxBodyBytes");
  var autoScreenshots = document.getElementById("autoScreenshots");
  var captureClientStorage = document.getElementById("captureClientStorage");
  var currentState = null;
  var activeTab = null;

  function send(messageBody) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(messageBody, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || response.ok === false) {
          reject(new Error(response && response.error ? response.error : "扩展后台没有响应"));
          return;
        }
        resolve(response);
      });
    });
  }

  function queryActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs.length ? tabs[0] : null);
      });
    });
  }

  function getSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([SETTINGS_KEY], function (saved) {
        resolve(saved && saved[SETTINGS_KEY] || {});
      });
    });
  }

  function saveMaxBodyBytes(value) {
    return getSettings().then(function (settings) {
      settings.maxBodyBytes = value;
      var obj = {};
      obj[SETTINGS_KEY] = settings;
      return new Promise(function (resolve) {
        chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; resolve(); });
      });
    });
  }

  function setText(id, value) {
    document.getElementById(id).textContent = String(value || 0);
  }

  function render(state) {
    currentState = state;
    var counters = state.counters || {};
    setText("requests", counters.requests);
    setText("responses", counters.responses);
    setText("apis", counters.apis);
    setText("actions", counters.actions);
    setText("consoleCount", counters.console);
    setText("screenshots", counters.screenshots);
    setText("targets", counters.targets);
    setText("storageSnapshots", counters.storageSnapshots);

    if (state.active) {
      badge.textContent = "REC";
      badge.className = "badge rec";
      primary.textContent = "停止并导出 ZIP";
      primary.className = "stop";
      captureBodies.disabled = true;
      maxBodyBytes.disabled = true;
      autoScreenshots.disabled = true;
      captureClientStorage.disabled = true;
    } else {
      badge.textContent = "IDLE";
      badge.className = "badge idle";
      primary.textContent = "开始完整采集";
      primary.className = "";
      captureBodies.disabled = false;
      maxBodyBytes.disabled = false;
      autoScreenshots.disabled = false;
      captureClientStorage.disabled = false;
    }
  }

  async function refresh() {
    activeTab = await queryActiveTab();
    target.textContent = activeTab ? (activeTab.title || activeTab.url || "当前标签页") : "未找到可采集标签页";
    var settings = await getSettings();
    var configuredLimit = settings.maxBodyBytes;
    if (configuredLimit === undefined || configuredLimit === null || configuredLimit === 5 * 1024 * 1024) configuredLimit = DEFAULT_MAX_BODY_BYTES;
    var optionValue = String(configuredLimit);
    if (!Array.from(maxBodyBytes.options).some(function (option) { return option.value === optionValue; })) optionValue = String(DEFAULT_MAX_BODY_BYTES);
    maxBodyBytes.value = optionValue;
    var response = await send({ type: "GET_STATUS" });
    render(response.state);
  }

  maxBodyBytes.addEventListener("change", function () {
    var value = Number(maxBodyBytes.value);
    saveMaxBodyBytes(value).catch(function (error) {
      message.className = "message error";
      message.textContent = error.message || String(error);
    });
  });

  primary.addEventListener("click", async function () {
    message.className = "message";
    message.textContent = "";
    primary.disabled = true;
    try {
      if (currentState && currentState.active) {
        message.textContent = "正在整理采集结果并生成 ZIP…";
        var stopped = await send({ type: "STOP_CAPTURE" });
        render(stopped.state);
        message.textContent = stopped.filename ? "已开始保存：" + stopped.filename : "采集已停止";
      } else {
        activeTab = activeTab || await queryActiveTab();
        if (!activeTab || typeof activeTab.id !== "number") {
          throw new Error("未找到当前标签页");
        }
        await saveMaxBodyBytes(Number(maxBodyBytes.value));
        var started = await send({
          type: "START_CAPTURE",
          tabId: activeTab.id,
          options: {
            captureBodies: captureBodies.checked,
            autoScreenshots: autoScreenshots.checked,
            captureClientStorage: captureClientStorage.checked
          }
        });
        render(started.state);
        message.textContent = "正在采集。保持此标签页正常操作即可。";
      }
    } catch (error) {
      message.className = "message error";
      message.textContent = error.message || String(error);
    } finally {
      primary.disabled = false;
    }
  });

  chrome.runtime.onMessage.addListener(function (event) {
    if (event && event.type === "STATE_UPDATED" && event.state) {
      render(event.state);
    }
  });

  refresh().catch(function (error) {
    message.className = "message error";
    message.textContent = error.message || String(error);
  });
}());
