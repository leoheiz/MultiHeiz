'use strict';

/**
 * Enumera sockets TCP Listen / UDP do process tree do MultiHeiz em vários cenários.
 * Uso: npm run check:sockets
 *      npm run check:sockets -- --variant=baseline|no-mdns|public-only|public-private|disable-udp|fixed
 *      npm run check:sockets -- --measure-all
 *
 * MULTIHEIZ_USERDATA throwaway; mock local only; sem diálogos.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

const VARIANTS = {
  baseline: {
    label: 'baseline (sem mitigação WebRTC)',
    disableExtra: '',
    policy: '',
  },
  'no-mdns': {
    label: 'disable-features += WebRtcHideLocalIpsWithMdns',
    disableExtra: 'WebRtcHideLocalIpsWithMdns',
    policy: '',
  },
  'no-discovery': {
    label: 'disable mDNS + MediaRouter/Dial/Cast',
    disableExtra:
      'WebRtcHideLocalIpsWithMdns,MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider',
    policy: '',
  },
  'public-only': {
    label: "mDNS off + webRTCIPHandlingPolicy = default_public_interface_only",
    disableExtra:
      'WebRtcHideLocalIpsWithMdns,MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider',
    policy: 'default_public_interface_only',
  },
  'public-private': {
    label: "mDNS off + webRTCIPHandlingPolicy = default_public_and_private_interfaces",
    disableExtra:
      'WebRtcHideLocalIpsWithMdns,MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider',
    policy: 'default_public_and_private_interfaces',
  },
  'disable-udp': {
    label: "mDNS off + webRTCIPHandlingPolicy = disable_non_proxied_udp (info only)",
    disableExtra:
      'WebRtcHideLocalIpsWithMdns,MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider',
    policy: 'disable_non_proxied_udp',
  },
  fixed: {
    label: 'produção (mitigação default do app)',
    disableExtra: '',
    policy: '',
    useAppDefault: true,
  },
};

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

function isLoopback(addr) {
  if (!addr) return true;
  const a = String(addr).toLowerCase();
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    a === '0:0:0:0:0:0:0:1' ||
    a.startsWith('127.') ||
    a === '::ffff:127.0.0.1'
  );
}

function isWildcard(addr) {
  if (!addr) return true;
  const a = String(addr).toLowerCase();
  return a === '0.0.0.0' || a === '::' || a === '::0' || a === '*';
}

function processTreePids(rootPid) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$root = ${Number(rootPid)}
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$map = @{}
foreach ($p in $all) { $map[[int]$p.ProcessId] = $p }
$keep = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$keep.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    $childPid = [int]$p.ProcessId
    $pp = [int]$p.ParentProcessId
    if ($keep.Contains($pp) -and -not $keep.Contains($childPid)) {
      [void]$keep.Add($childPid)
      $changed = $true
    }
  }
}
$out = @()
foreach ($id in $keep) {
  $p = $map[$id]
  if (-not $p) { continue }
  $type = 'main'
  $cl = [string]$p.CommandLine
  if ($cl -match '--type=gpu-process') { $type = 'gpu' }
  elseif ($cl -match '--type=utility') { $type = 'utility' }
  elseif ($cl -match '--type=renderer') { $type = 'renderer' }
  elseif ($cl -match '--type=zygote') { $type = 'zygote' }
  elseif ($p.Name -and $p.Name -ne 'electron.exe' -and $p.Name -ne 'MultiHeiz.exe') { $type = $p.Name }
  $out += [pscustomobject]@{ pid = $id; type = $type; name = $p.Name }
}
$out | ConvertTo-Json -Compress
`;
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  ).trim();
  if (!raw) return [{ pid: rootPid, type: 'main', name: 'electron.exe' }];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function enumerateSockets(pids) {
  const idList = pids.map((p) => Number(p.pid)).filter(Boolean);
  const pidSet = new Set(idList);
  const typeByPid = new Map(pids.map((p) => [Number(p.pid), p.type]));
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$pids = @(${idList.join(',')})
$tcp = @(Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object LocalAddress, LocalPort, OwningProcess, State)
$udp = @(Get-NetUDPEndpoint | Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object LocalAddress, LocalPort, OwningProcess)
@{ tcp = $tcp; udp = $udp } | ConvertTo-Json -Compress -Depth 4
`;
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  ).trim();
  let data = { tcp: [], udp: [] };
  try {
    data = JSON.parse(raw || '{}');
  } catch {
    data = { tcp: [], udp: [] };
  }
  const norm = (rows, kind) => {
    const arr = !rows ? [] : Array.isArray(rows) ? rows : [rows];
    return arr
      .map((r) => ({
        kind,
        localAddress: String(r.LocalAddress || ''),
        localPort: Number(r.LocalPort),
        pid: Number(r.OwningProcess),
        processType: typeByPid.get(Number(r.OwningProcess)) || 'unknown',
        state: r.State || undefined,
      }))
      .filter((r) => pidSet.has(r.pid));
  };
  return {
    tcp: norm(data.tcp, 'tcp'),
    udp: norm(data.udp, 'udp'),
  };
}

function classifyReport(snapshot, phase) {
  const tcpNonLoop = snapshot.tcp.filter((s) => !isLoopback(s.localAddress));
  const udp5353 = snapshot.udp.filter(
    (s) =>
      s.localPort === 5353 &&
      (isWildcard(s.localAddress) || !isLoopback(s.localAddress))
  );
  const udpWildcard = snapshot.udp.filter((s) => isWildcard(s.localAddress));
  const udpNonLoop = snapshot.udp.filter(
    (s) => !isLoopback(s.localAddress) && !isWildcard(s.localAddress)
  );
  return {
    phase,
    tcpListen: snapshot.tcp,
    udp: snapshot.udp,
    tcpNonLoopback: tcpNonLoop,
    udp5353,
    udpWildcard,
    udpInterfaceBound: udpNonLoop,
  };
}

function printPhaseReport(report) {
  console.log(`\n=== phase: ${report.phase} ===`);
  const fmt = (s) =>
    `${s.kind.toUpperCase()} ${s.localAddress}:${s.localPort} pid=${s.pid} (${s.processType})`;
  if (report.tcpNonLoopback.length) {
    console.log('NON-LOOPBACK TCP LISTEN:');
    report.tcpNonLoopback.forEach((s) => console.log('  ', fmt(s)));
  } else {
    console.log('NON-LOOPBACK TCP LISTEN: (none)');
  }
  if (report.udp5353.length) {
    console.log('UDP 5353 (mDNS suspect):');
    report.udp5353.forEach((s) => console.log('  ', fmt(s)));
  } else {
    console.log('UDP 5353: (none)');
  }
  if (report.udpWildcard.length) {
    console.log('UDP wildcard (0.0.0.0 / ::):');
    report.udpWildcard.forEach((s) => console.log('  ', fmt(s)));
  } else {
    console.log('UDP wildcard: (none)');
  }
  if (report.udpInterfaceBound.length) {
    const tag = report.phase === 'webrtc' ? 'INFO (ICE host/interface)' : 'UDP interface-bound';
    console.log(tag + ':');
    report.udpInterfaceBound.forEach((s) => console.log('  ', fmt(s)));
  }
}

/**
 * Chromium's network.mojom.NetworkService binds ephemeral UDP on 0.0.0.0 for
 * DNS/QUIC/etc. even at idle — unavoidable without breaking net. The Firewall
 * prompt Leo saw tracks WebRTC mDNS (UDP 5353) and discovery (SSDP 1900), not
 * those high ephemeral NetworkService sockets. Assert against discovery ports;
 * report other wildcards as INFO.
 */
function isDiscoveryOrPrivilegedUdp(s) {
  const port = Number(s.localPort);
  return port === 5353 || port === 1900 || port < 1024;
}

function assertSocketPolicy(reports) {
  for (const r of reports) {
    assert(
      r.tcpNonLoopback.length === 0,
      `phase ${r.phase}: non-loopback TCP listen: ${JSON.stringify(r.tcpNonLoopback)}`
    );
    assert(
      r.udp5353.length === 0,
      `phase ${r.phase}: UDP 5353 present: ${JSON.stringify(r.udp5353)}`
    );
    const badWild = r.udpWildcard.filter(isDiscoveryOrPrivilegedUdp);
    assert(
      badWild.length === 0,
      `phase ${r.phase}: discovery/privileged wildcard UDP: ${JSON.stringify(badWild)}`
    );
    const infoWild = r.udpWildcard.filter((s) => !isDiscoveryOrPrivilegedUdp(s));
    if (infoWild.length) {
      console.log(
        `INFO phase ${r.phase}: NetworkService ephemeral wildcard UDP (Chromium baseline):`,
        infoWild.map((s) => `${s.localAddress}:${s.localPort}/${s.processType}`).join(', ')
      );
    }
    if (r.phase === 'webrtc' && r.udpInterfaceBound.length) {
      console.log(
        'INFO phase webrtc: ICE interface-bound UDP:',
        r.udpInterfaceBound.map((s) => `${s.localAddress}:${s.localPort}/${s.processType}`).join(', ')
      );
    }
  }
}

function readPhase(controlDir) {
  const p = path.join(controlDir, 'phase.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeAck(controlDir, phase) {
  fs.writeFileSync(path.join(controlDir, 'ack'), phase);
}

async function runVariant(variantKey) {
  const variant = VARIANTS[variantKey];
  assert(variant, 'unknown variant ' + variantKey);
  console.log('\n######## VARIANT:', variantKey, '—', variant.label);

  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sockets-ud-'));
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sockets-ctl-'));
  const reports = [];

  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'sockets',
    MULTIHEIZ_SOCKETS_CONTROL: controlDir,
    MULTIHEIZ_UI_WIDTH: '1024',
    MULTIHEIZ_UI_HEIGHT: '700',
    ELECTRON_ENABLE_LOGGING: '1',
  };

  if (!variant.useAppDefault) {
    if (variant.disableExtra) {
      env.MULTIHEIZ_SOCKETS_DISABLE_EXTRA = variant.disableExtra;
    }
    if (variant.policy) {
      env.MULTIHEIZ_WEBRTC_IP_POLICY = variant.policy;
    }
    // baseline / measure modes: tell main not to apply production WebRTC mitigations
    env.MULTIHEIZ_SOCKETS_MEASURE = '1';
  }

  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let out = '';
  const onData = (buf) => {
    const s = buf.toString();
    out += s;
    process.stdout.write(s);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const mainPid = child.pid;
  const phasesWanted = ['idle', 'webrtc', 'gum', 'modules'];
  let lastPhase = '';
  const deadline = Date.now() + 180000;

  try {
    while (Date.now() < deadline) {
      if (child.exitCode != null && child.exitCode !== 0) {
        throw new Error('electron exited early: ' + child.exitCode);
      }
      const ph = readPhase(controlDir);
      if (ph && ph.phase && ph.phase !== lastPhase) {
        if (phasesWanted.includes(ph.phase)) {
          await new Promise((r) => setTimeout(r, 400));
          const tree = processTreePids(ph.pid || mainPid);
          const socks = enumerateSockets(tree);
          const report = classifyReport(socks, ph.phase);
          printPhaseReport(report);
          reports.push(report);
          lastPhase = ph.phase;
          writeAck(controlDir, ph.phase);
        } else if (ph.phase === 'done') {
          lastPhase = 'done';
          writeAck(controlDir, 'done');
          break;
        }
      }
      if (lastPhase === 'modules') {
        // wait for done / exit
        const ph2 = readPhase(controlDir);
        if (ph2 && ph2.phase === 'done') {
          writeAck(controlDir, 'done');
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    assert(reports.length >= 4, 'expected 4 phase reports, got ' + reports.length);

    const exitCode = await new Promise((resolve) => {
      if (child.exitCode != null) return resolve(child.exitCode);
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(-1);
      }, 30000);
      child.on('close', (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    assert(exitCode === 0, 'electron exit ' + exitCode);

    return { variant: variantKey, label: variant.label, reports, out };
  } finally {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(controlDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function summarizeVariant(result) {
  const webrtc = result.reports.find((r) => r.phase === 'webrtc') || result.reports[0];
  const idle = result.reports.find((r) => r.phase === 'idle');
  return {
    variant: result.variant,
    label: result.label,
    idleTcpNonLoop: idle ? idle.tcpNonLoopback.length : -1,
    idleUdp5353: idle ? idle.udp5353.length : -1,
    idleUdpWild: idle ? idle.udpWildcard.length : -1,
    webrtcTcpNonLoop: webrtc.tcpNonLoopback.length,
    webrtcUdp5353: webrtc.udp5353.length,
    webrtcUdpWild: webrtc.udpWildcard.length,
    webrtcUdpIface: webrtc.udpInterfaceBound.length,
    ifaceSample: webrtc.udpInterfaceBound.slice(0, 5).map(
      (s) => `${s.localAddress}:${s.localPort}/${s.processType}`
    ),
  };
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP: check:sockets is Windows-only (Get-NetTCPConnection)');
    process.exit(0);
  }

  const args = process.argv.slice(2);
  const measureAll = args.includes('--measure-all');
  const variantArg = args.find((a) => a.startsWith('--variant='));
  const variantKey = variantArg
    ? variantArg.slice('--variant='.length)
    : measureAll
      ? null
      : 'fixed';

  if (measureAll) {
    const keys = [
      'baseline',
      'no-mdns',
      'no-discovery',
      'public-only',
      'public-private',
      'disable-udp',
    ];
    const summaries = [];
    for (const k of keys) {
      const r = await runVariant(k);
      summaries.push(summarizeVariant(r));
    }
    console.log('\n======== MEASURE-ALL SUMMARY ========');
    console.log(JSON.stringify(summaries, null, 2));
    const outPath = path.join(root, '_local', 'sockets-measure.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summaries, null, 2));
    console.log('wrote', outPath);
    process.exit(0);
  }

  const result = await runVariant(variantKey);
  console.log('\n======== ASSERTIONS ========');
  assertSocketPolicy(result.reports);
  console.log('PASS: check:sockets variant=' + variantKey);
  const summary = summarizeVariant(result);
  console.log(JSON.stringify(summary, null, 2));
  const outPath = path.join(root, '_local', 'sockets-last.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ summary, reports: result.reports }, null, 2)
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
