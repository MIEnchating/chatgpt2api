"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../package.json");

test("Windows signing is left to electron-builder so CSC_LINK can enable it", () => {
  assert.equal(config.build.win.signExecutable, undefined);
  assert.equal(config.build.win.signAndEditExecutable, undefined);
});
