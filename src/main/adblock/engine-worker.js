'use strict';

/**
 * Worker thread: parse filter lists + serialize engine.bin off the Electron main process.
 * Main only deserializes the resulting buffer and swaps the live blocker.
 */

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const { FiltersEngine } = require('@ghostery/adblocker');

/**
 * @param {object} msg
 */
function compile(msg) {
  const text = typeof msg.text === 'string' ? msg.text : '';
  const config = msg.config && typeof msg.config === 'object' ? msg.config : {};
  const engine = FiltersEngine.parse(text, config);
  const resourcesText = typeof msg.resourcesText === 'string' ? msg.resourcesText : '';
  if (resourcesText) {
    engine.updateResources(resourcesText, '' + resourcesText.length);
  }
  const bin = Buffer.from(engine.serialize());
  const engineOutPath = typeof msg.engineOutPath === 'string' ? msg.engineOutPath : '';
  if (engineOutPath && !msg.skipSerialize) {
    const dir = require('node:path').dirname(engineOutPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(engineOutPath, bin);
  }
  return { ok: true, bin };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    try {
      if (!msg || msg.type !== 'compile') {
        parentPort.postMessage({ ok: false, error: 'mensagem inválida' });
        return;
      }
      const result = compile(msg);
      parentPort.postMessage({ ok: true, bin: result.bin });
    } catch (err) {
      parentPort.postMessage({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  });
}

module.exports = { compile };
