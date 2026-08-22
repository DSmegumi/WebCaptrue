(function (global) {
  "use strict";

  var encoder = new TextEncoder();
  var crcTable = null;

  function buildCrcTable() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    if (!crcTable) crcTable = buildCrcTable();
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  }

  function u32(value) {
    return new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    ]);
  }

  function concat(parts) {
    var length = parts.reduce(function (sum, p) { return sum + p.length; }, 0);
    var out = new Uint8Array(length);
    var offset = 0;
    parts.forEach(function (p) { out.set(p, offset); offset += p.length; });
    return out;
  }

  function dateBits(date) {
    var year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
      date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
    };
  }

  function normalizeData(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return encoder.encode(String(data));
  }

  function createZip(files) {
    var locals = [];
    var centrals = [];
    var offset = 0;
    var now = dateBits(new Date());

    files.forEach(function (file) {
      var name = encoder.encode(file.path.replace(/^\/+/, ""));
      var data = normalizeData(file.data);
      var crc = crc32(data);
      var local = concat([
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(now.time), u16(now.date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
      ]);
      var central = concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(now.time), u16(now.date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0),
        u16(0), u32(0), u32(offset), name
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    });

    var centralBlob = concat(centrals);
    var end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralBlob.length), u32(offset), u16(0)
    ]);
    return new Blob(locals.concat([centralBlob, end]), { type: "application/zip" });
  }

  global.WebCaptrueZip = { createZip: createZip };
}(typeof self !== "undefined" ? self : window));
