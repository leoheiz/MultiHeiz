'use strict';

/**
 * Selftest: Iniciar com o sistema (HKCU Run / XDG autostart).
 * Uses name MultiHeizSelftest so Leo's real Run entries are never touched.
 */

async function runAutostartSelftest(ctx) {
  const { sleep, app, autostart, updateState, flushSave } = ctx;

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  const platform = process.platform;
  console.log('[selftest-autostart] platform=', platform);

  // Always clean first
  autostart.cleanupSelftest();
  await sleep(200);

  try {
    if (platform === 'win32') {
      assert(autostart.readWindowsRunValue() == null, 'Run value must be absent before toggle');

      const on = autostart.setAutostart({ openAtLogin: true, openAsHidden: false });
      assert(on.ok, 'setAutostart on failed: ' + (on.error || ''));
      await sleep(300);

      const val = autostart.readWindowsRunValue();
      assert(val, 'HKCU Run MultiHeizSelftest missing after enable');
      const launch = autostart.resolveLaunch();
      assert(launch.ok && launch.path, 'resolveLaunch ok');
      assert(
        String(val).toLowerCase().includes(String(launch.path).toLowerCase()) ||
          String(val).toLowerCase().includes('electron'),
        'Run value should reference launch path: ' + val
      );
      console.log('PASS: HKCU Run set →', val);

      updateState((s) => {
        s.settings.openAtLogin = true;
        s.settings.openAsHidden = false;
      });
      flushSave();

      const off = autostart.setAutostart({ openAtLogin: false, openAsHidden: false });
      assert(off.ok, 'setAutostart off failed: ' + (off.error || ''));
      await sleep(300);
      assert(autostart.readWindowsRunValue() == null, 'HKCU Run still present after disable');
      console.log('PASS: HKCU Run removed');

      // openAsHidden adds --hidden
      const hid = autostart.setAutostart({ openAtLogin: true, openAsHidden: true });
      assert(hid.ok, 'setAutostart hidden failed');
      await sleep(200);
      const val2 = autostart.readWindowsRunValue();
      assert(val2, 'Run value missing for hidden');
      assert(/--hidden/i.test(String(val2)), 'Run value should include --hidden: ' + val2);
      console.log('PASS: --hidden in Run value');

      autostart.setAutostart({ openAtLogin: false, openAsHidden: false });
      await sleep(200);
      assert(autostart.readWindowsRunValue() == null, 'cleanup after hidden');
    } else if (platform === 'linux') {
      const file = autostart.linuxAutostartPath();
      assert(!require('node:fs').existsSync(file), 'autostart file must be absent before');

      process.env.MULTIHEIZ_AUTOSTART_EXEC = '/tmp/multiheiz-selftest-fake';
      const on = autostart.setAutostart({ openAtLogin: true, openAsHidden: false });
      assert(on.ok, 'linux setAutostart on: ' + (on.error || ''));
      const fs = require('node:fs');
      assert(fs.existsSync(file), 'desktop file missing: ' + file);
      const body = fs.readFileSync(file, 'utf8');
      assert(/StartupWMClass=multiheiz/.test(body), 'StartupWMClass');
      assert(/Icon=multiheiz/.test(body), 'Icon');
      assert(body.includes('/tmp/multiheiz-selftest-fake'), 'Exec path');
      console.log('PASS: XDG autostart file written', file);

      const off = autostart.setAutostart({ openAtLogin: false });
      assert(off.ok, 'linux off');
      assert(!fs.existsSync(file), 'desktop file still present');
      console.log('PASS: XDG autostart file removed');
    } else {
      console.log('SKIP: autostart selftest unsupported platform', platform);
    }

    console.log('PASS: selftest-autostart');
    app.exit(0);
  } catch (err) {
    try {
      autostart.cleanupSelftest();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = { runAutostartSelftest };
