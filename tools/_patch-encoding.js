'use strict';
const fs = require('fs');
const path = require('path');

function toUtf8(file) {
  const buf = fs.readFileSync(file);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString('utf16le', 2);
  } else if (buf.length >= 2 && buf[1] === 0 && buf[3] === 0) {
    text = buf.toString('utf16le');
  } else {
    text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  fs.writeFileSync(file, text, 'utf8');
}

const root = path.join(__dirname, '..');
const target = path.join(root, 'src', 'main', 'selftest-v18.js');
toUtf8(target);

let t = fs.readFileSync(target, 'utf8');

t = t.replace(
  /const ECHO_HEADERS = \(req, res\) => \{[\s\S]*?\n  \};/,
  `const ECHO_HEADERS = (req, res) => {
    const payload = JSON.stringify({
      ua: req.headers['user-agent'] || '',
      secChUa: req.headers['sec-ch-ua'] || '',
      secChUaMobile: req.headers['sec-ch-ua-mobile'] || '',
      secChUaPlatform: req.headers['sec-ch-ua-platform'] || '',
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html><body><pre id="echo">' +
        payload.replace(/</g, '\\\\u003c') +
        '</pre></body></html>'
    );
  };`
);

t = t.replace(
  /panels\.createPanel\('acc-v18-a'\);\r?\n  const sesA = session\.fromPartition\(panels\.partitionFor\('acc-v18-a'\)\);\r?\n  userAgent\.applySessionUserAgent\(sesA\);\r?\n  sessionPersist\.hookSessionCookies\(sesA\);\r?\n\r?\n  \/\/ Echo headers via panel navigation\r?\n  panels\.panelNavigate\('acc-v18-a', `\$\{base\}\/echo-headers`\);\r?\n  await waitForUrl\('acc-v18-a', \(u\) => u\.includes\('\/echo-headers'\), 20000\);\r?\n  await sleep\(400\);\r?\n  const echo = await panels\.getPanelCapture\('acc-v18-a'\)\.executeJavaScript\('document\.body\.innerText'\);/,
  `updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-v18-a');
    if (a) {
      a.lastUrl = \`\${base}/echo-headers\`;
      a.startUrl = \`\${base}/echo-headers\`;
    }
  });
  panels.createPanel('acc-v18-a');
  const sesA = session.fromPartition(panels.partitionFor('acc-v18-a'));
  userAgent.applySessionUserAgent(sesA);
  sessionPersist.hookSessionCookies(sesA);

  await waitForUrl('acc-v18-a', (u) => u.includes('/echo-headers'), 20000);
  await sleep(600);
  const echo = await panels
    .getPanelCapture('acc-v18-a')
    .executeJavaScript('(document.getElementById(\"echo\")||document.body).textContent');`
);

fs.writeFileSync(target, t, 'utf8');
console.log('patched', target);
