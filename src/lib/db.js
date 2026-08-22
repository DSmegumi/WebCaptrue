(function (global) {
  "use strict";

  var DB_NAME = "webcaptrue-capture";
  var DB_VERSION = 1;
  var STORE = "records";

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("sessionId", "sessionId", { unique: false });
          store.createIndex("type", "type", { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function CaptureDB() {
    this.dbPromise = openDb();
  }

  CaptureDB.prototype.add = async function (record) {
    var db = await this.dbPromise;
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(record);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  };

  CaptureDB.prototype.clearSession = async function (sessionId) {
    var db = await this.dbPromise;
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      var index = tx.objectStore(STORE).index("sessionId");
      var cursorReq = index.openCursor(IDBKeyRange.only(sessionId));
      cursorReq.onsuccess = function () {
        var cursor = cursorReq.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  };

  CaptureDB.prototype.getSessionRecords = async function (sessionId) {
    var db = await this.dbPromise;
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readonly");
      var index = tx.objectStore(STORE).index("sessionId");
      var request = index.getAll(IDBKeyRange.only(sessionId));
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function () { reject(request.error); };
    });
  };

  global.WebCaptrueDB = CaptureDB;
}(typeof self !== "undefined" ? self : window));
