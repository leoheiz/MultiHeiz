'use strict';

/**
 * E2E favorites: 1.3.0 bookmarks.json fixture visible in popover/page/catalog,
 * then add via real UI and open into a panel.
 * Uso: npm run selftest:favorites-e2e
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function run() {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-fav-e2e-'));
    // 1.3.0-format fixture (pre-v2 folders) — same shape as bc7309f era
    fs.writeFileSync(
      path.join(userdata, 'bookmarks.json'),
      JSON.stringify(
        {
          version: 1,
          folders: [{ id: 'folder-default', name: 'Favoritos', order: 0 }],
          items: [
            {
              id: 'bm-legacy-1',
              url: 'https://example.com/legacy-fav',
              name: 'Legacy Fav',
              title: 'Legacy Fav',
              folderId: 'folder-default',
              createdAt: 1,
            },
            {
              id: 'bm-legacy-2',
              url: 'https://example.com/legacy-two',
              name: 'Legacy Two',
              title: 'Legacy Two',
              folderId: 'folder-default',
              createdAt: 2,
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'favorites-e2e',
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '860',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:favorites-e2e');
    console.log('userdata:', userdata);
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('favorites-e2e selftest timed out'));
    }, 240000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (code === 0) resolve(out);
      else reject(new Error('favorites-e2e selftest exited with code ' + code));
    });
  });
}

run()
  .then(() => {
    console.log('PASS: selftest:favorites-e2e complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
