const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const powershell = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const isWindowsPowerShellAvailable = process.platform === 'win32' && fs.existsSync(powershell);
const projectRoot = path.resolve(__dirname, '..');
const forbiddenTestPorts = new Set([4173]);
const testCreatedPidsByEntry = new Map();

const testServerSource = String.raw`
const http = require('node:http');
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.url === '/api/health') {
    response.end(JSON.stringify({ product: 'hainanu-2027-kaoyan-guide', schemaVersion: 2, live: true, ready: true }));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<main data-product="hainanu-2027-kaoyan-guide">test</main>');
});
server.listen(port, '127.0.0.1');
`;

const shortLivedServerSource = String.raw`
setTimeout(() => process.exit(23), 1500);
setInterval(() => {}, 1000);
`;

const delayedReadyServerSource = String.raw`
const http = require('node:http');
const port = Number(process.env.PORT);
setTimeout(() => {
  http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ product: 'hainanu-2027-kaoyan-guide', schemaVersion: 2, live: true, ready: true }));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<main data-product="hainanu-2027-kaoyan-guide">delayed</main>');
  }).listen(port, '127.0.0.1');
}, 5000);
`;

const liveButNotReadyServerSource = String.raw`
const http = require('node:http');
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ product: 'hainanu-2027-kaoyan-guide', schemaVersion: 2, live: true, ready: false, status: 'seed' }));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<main data-product="hainanu-2027-kaoyan-guide">live seed</main>');
});
server.listen(port, '127.0.0.1');
`;

const parentWithWorkerServerSource = String.raw`
const { spawn } = require('node:child_process');
const http = require('node:http');
if (process.argv.includes('--worker')) {
  const port = Number(process.env.PORT);
  http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ product: 'hainanu-2027-kaoyan-guide', schemaVersion: 2, live: true, ready: true }));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<main data-product="hainanu-2027-kaoyan-guide">worker</main>');
  }).listen(port, '127.0.0.1');
} else {
  const worker = spawn(process.execPath, [__filename, '--worker'], {
    detached: true,
    env: process.env,
    stdio: 'ignore'
  });
  worker.unref();
  setInterval(() => {}, 1000);
}
`;

async function canBindPort(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

async function getUnusedPort(excludedPorts = []) {
  const excluded = new Set([...forbiddenTestPorts, ...excludedPorts]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 49_152 + Math.floor(Math.random() * (65_535 - 49_152 + 1));
    if (excluded.has(port)) continue;
    if (!await canBindPort(port)) continue;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!await canBindPort(port)) continue;
    forbiddenTestPorts.add(port);
    return port;
  }
  throw new Error('could not reserve a distinct free high port after 100 attempts');
}

async function assertPortFreeBeforeLaunch(port) {
  assert.notEqual(port, 4173, 'lifecycle tests must never use port 4173');
  assert.equal(await canBindPort(port), true, `test port ${port} was claimed before launch`);
}

function getPidPath(projectDirectory, port = 4173) {
  const fileName = port === 4173 ? 'server.pid' : `server-${port}.pid`;
  return path.join(projectDirectory, 'data', fileName);
}

function getGlobalMutexName(projectDirectory, port) {
  const seed = `${path.resolve(projectDirectory).replace(/[\\/]+$/, '').toLowerCase()}|${port}`;
  const hash = createHash('sha256').update(seed, 'utf8').digest('hex').toUpperCase();
  return `Global\\HainanuGuide-${hash}`;
}

function canOpenNamedMutex(mutexName) {
  const command = String.raw`
$mutex = $null
try {
  $mutex = [System.Threading.Mutex]::OpenExisting($env:HNU_TEST_MUTEX_NAME)
  exit 0
} catch {
  Write-Error $_
  exit 1
} finally {
  if ($null -ne $mutex) { $mutex.Dispose() }
}
`;
  return require('node:child_process').spawnSync(
    powershell,
    ['-NoProfile', '-Command', command],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, HNU_TEST_MUTEX_NAME: mutexName } }
  );
}

function holdNamedMutex(mutexName, holdMilliseconds = 3000) {
  const command = String.raw`
$mutex = $null
$owned = $false
try {
  $mutex = New-Object System.Threading.Mutex($false, $env:HNU_TEST_MUTEX_NAME)
  $owned = $mutex.WaitOne(5000)
  if (-not $owned) { throw 'test mutex holder timed out' }
  Write-Output 'READY'
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ([int]$env:HNU_TEST_MUTEX_HOLD_MS)
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
`;
  const child = spawn(powershell, ['-NoProfile', '-Command', command], {
    env: {
      ...process.env,
      HNU_TEST_MUTEX_NAME: mutexName,
      HNU_TEST_MUTEX_HOLD_MS: String(holdMilliseconds)
    },
    windowsHide: true
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('READY')) resolve();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!stdout.includes('READY')) reject(new Error(`mutex holder exited ${code}: ${stderr || stdout}`));
    });
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mutex holder exited ${code}: ${stderr || stdout}`)));
  });
  return { child, ready, exited };
}

function runPowerShellFile(scriptPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args.map(String)
    ], {
      cwd: options.cwd || path.dirname(scriptPath),
      env: options.env || process.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      try {
        const candidateEntry = path.join(options.cwd || path.dirname(scriptPath), 'server.cjs');
        if (candidateEntry.includes(`${path.sep}hnu-guide-task4-`) && fs.existsSync(candidateEntry)) {
          recordExactEntryProcesses(candidateEntry);
        }
        resolve({ code, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runBatchFile(batchPath, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('C:\\WINDOWS\\System32\\cmd.exe', ['/d', '/c', batchPath], {
      cwd: options.cwd || path.dirname(batchPath),
      env: options.env || process.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end('\n');
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function getProcessInfo(pid) {
  const command = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    "if ($null -ne $process) { $process | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress }"
  ].join('; ');
  const result = require('node:child_process').spawnSync(powershell, [
    '-NoProfile', '-Command', command
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`CIM query failed for PID ${pid}: ${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function parseWindowsCommandLine(commandLine) {
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/.test(commandLine[index] || '')) index += 1;
    if (index >= commandLine.length) break;
    let value = '';
    let inQuotes = false;
    while (index < commandLine.length) {
      if (!inQuotes && /\s/.test(commandLine[index])) break;
      if (commandLine[index] === '\\') {
        let slashCount = 0;
        while (commandLine[index + slashCount] === '\\') slashCount += 1;
        if (commandLine[index + slashCount] === '"') {
          value += '\\'.repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 0) {
            inQuotes = !inQuotes;
          } else {
            value += '"';
          }
          index += slashCount + 1;
          continue;
        }
        value += '\\'.repeat(slashCount);
        index += slashCount;
        continue;
      }
      if (commandLine[index] === '"') {
        inQuotes = !inQuotes;
        index += 1;
        continue;
      }
      value += commandLine[index];
      index += 1;
    }
    args.push(value);
    while (/\s/.test(commandLine[index] || '')) index += 1;
  }
  return args;
}

function getNodeProcessInfos() {
  const command = [
    "$processes = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" -ErrorAction Stop",
    "$processes | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress"
  ].join('; ');
  const result = require('node:child_process').spawnSync(powershell, [
    '-NoProfile', '-Command', command
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`CIM ownership query failed: ${result.stderr}`);
  }
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getExactEntryProcesses(serverScript) {
  const expected = path.resolve(serverScript).toLowerCase();
  return getNodeProcessInfos().filter((info) => {
    if (!/^node(?:\.exe)?$/i.test(info.Name) || typeof info.CommandLine !== 'string') return false;
    const args = parseWindowsCommandLine(info.CommandLine);
    return args.length >= 2 && path.resolve(args[1]).toLowerCase() === expected;
  });
}

function recordTestProcess(serverScript, pid) {
  const key = path.resolve(serverScript).toLowerCase();
  const pids = testCreatedPidsByEntry.get(key) || new Set();
  pids.add(Number(pid));
  testCreatedPidsByEntry.set(key, pids);
}

function recordExactEntryProcesses(serverScript) {
  for (const info of getExactEntryProcesses(serverScript)) {
    recordTestProcess(serverScript, info.ProcessId);
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

async function cleanupOwnedServer(projectDirectory) {
  const serverScript = path.join(projectDirectory, 'server.cjs');
  await cleanupOwnedScript(serverScript);
}

function getEntryProcessesUnder(projectDirectory) {
  const rootPrefix = `${path.resolve(projectDirectory).toLowerCase()}${path.sep}`;
  return getNodeProcessInfos().filter((info) => {
    if (typeof info.CommandLine !== 'string') return false;
    const args = parseWindowsCommandLine(info.CommandLine);
    if (args.length < 2) return false;
    return path.resolve(args[1]).toLowerCase().startsWith(rootPrefix);
  });
}

async function cleanupRecordedProjectProcesses(projectDirectory) {
  const rootPrefix = `${path.resolve(projectDirectory).toLowerCase()}${path.sep}`;
  const entries = [...testCreatedPidsByEntry.keys()].filter((entry) => entry.startsWith(rootPrefix));
  const errors = [];
  for (const entry of entries) {
    try {
      await cleanupOwnedScript(entry);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const remaining = getEntryProcessesUnder(projectDirectory);
    if (remaining.length > 0) {
      errors.push(new Error(`recorded project processes remain: ${JSON.stringify(remaining)}`));
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `project process cleanup failed for ${projectDirectory}`);
  }
}

async function cleanupOwnedScript(serverScript) {
  const key = path.resolve(serverScript).toLowerCase();
  const recordedPids = testCreatedPidsByEntry.get(key) || new Set();
  const cleanupErrors = [];
  for (const pid of recordedPids) {
    try {
      const info = getProcessInfo(pid);
      if (!info) continue;
      const args = typeof info.CommandLine === 'string' ? parseWindowsCommandLine(info.CommandLine) : [];
      const isOwned = /^node(?:\.exe)?$/i.test(info.Name)
        && args.length >= 2
        && path.resolve(args[1]).toLowerCase() === key;
      if (!isOwned) {
        throw new Error(`refusing to clean unverified PID ${pid}: ${JSON.stringify(info)}`);
      }
      process.kill(pid);
      await waitFor(() => getProcessInfo(pid) === null, 5000);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    const untracked = getExactEntryProcesses(serverScript)
      .filter((info) => !recordedPids.has(Number(info.ProcessId)));
    if (untracked.length > 0) {
      cleanupErrors.push(new Error(`exact-entry processes were not recorded as test-created: ${JSON.stringify(untracked)}`));
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `cleanup failed for ${serverScript}`);
  }
  testCreatedPidsByEntry.delete(key);
}

function createLifecycleProject(t, serverSource = testServerSource) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hnu-guide-task4-'));
  fs.mkdirSync(path.join(projectDirectory, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectDirectory, 'data'), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'scripts', 'launch.ps1'), path.join(projectDirectory, 'scripts', 'launch.ps1'));
  fs.copyFileSync(path.join(projectRoot, 'scripts', 'log-cleanup.ps1'), path.join(projectDirectory, 'scripts', 'log-cleanup.ps1'));
  fs.copyFileSync(path.join(projectRoot, 'scripts', 'stop.ps1'), path.join(projectDirectory, 'scripts', 'stop.ps1'));
  fs.writeFileSync(path.join(projectDirectory, 'server.cjs'), serverSource);
  t.after(async () => {
    const errors = [];
    try {
      await cleanupRecordedProjectProcesses(projectDirectory);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        const remaining = getEntryProcessesUnder(projectDirectory);
        if (remaining.length === 0) {
          fs.rmSync(projectDirectory, { recursive: true, force: true });
        } else {
          errors.push(new Error(`temporary project kept because exact-entry processes remain: ${JSON.stringify(remaining)}`));
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `teardown failed for ${projectDirectory}`);
    }
  });
  return projectDirectory;
}

let createServer;
try {
  ({ createServer } = require('../scripts/serve.cjs'));
} catch {
  createServer = undefined;
}

test('serves the complete offline site and nine focused guide pages with shared navigation', async (t) => {
  assert.equal(typeof createServer, 'function', 'createServer must be exported');

  const root = path.resolve(__dirname, '..');
  const server = createServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const pages = [
    ['/', '首页', 'data-page="home"'],
    ['/programs.html', '专业选择', 'data-page="programs"'],
    ['/scores.html', '2026 届分数', 'data-page="scores"'],
    ['/preparation.html', '初复试备考', 'data-page="preparation"'],
    ['/timeline.html', '全年时间轴', 'data-page="timeline"'],
    ['/application.html', '报名流程', 'data-page="application"'],
    ['/materials.html', '材料清单', 'data-page="materials"'],
    ['/updates.html', '官方动态', 'data-page="updates"'],
    ['/sources.html', '官方信源', 'data-page="sources"']
  ];
  const expectedTaskIds = [
    'program-academic', 'program-computer', 'program-software',
    'stage-baseline', 'stage-directory', 'stage-preapply', 'stage-apply', 'stage-confirm',
    'stage-ticket', 'stage-exam-logistics', 'stage-retest-material', 'stage-retest-plan', 'stage-archive',
    'material-id', 'material-student', 'material-photo', 'material-point', 'material-file', 'material-contact',
    'material-special', 'material-backup'
  ].sort();
  const servedHtml = [];

  for (const [pathname, label, marker] of pages) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, `${pathname} must return 200`);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await response.text();
    servedHtml.push(html);
    assert.match(html, new RegExp(marker));
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${pathname} must contain exactly one h1`);
    assert.match(html, /<link\b[^>]*href="\/styles\.css"/);
    assert.match(html, /<script\b[^>]*src="\/app\.js"/);
    assert.match(
      html,
      new RegExp(`<a\\b(?=[^>]*href="${pathname}")(?=[^>]*aria-current="page")[^>]*>\\s*${label}\\s*</a>`),
      `${pathname} must mark ${label} as the current global navigation link`
    );
  }

  const combinedHtml = servedHtml.join('\n');
  const htmlByPath = new Map(pages.map(([pathname], index) => [pathname, servedHtml[index]]));
  for (const [pathname, id] of [['/scores.html', 'scores'], ['/preparation.html', 'exam'], ['/preparation.html', 'risks'], ['/materials.html', 'materials'], ['/sources.html', 'sources']]) {
    assert.match(htmlByPath.get(pathname), new RegExp(`id="${id}"`));
    assert.equal((combinedHtml.match(new RegExp(`\\sid="${id}"`, 'g')) || []).length, 1, `${id} content must live on only one page`);
  }
  for (const [pathname, html] of htmlByPath) {
    assert.equal((html.match(/class="site-nav-link"/g) || []).length, pages.length);
    for (const [, href] of html.matchAll(/href="(\/[^"?#]*(?:#[^"]*)?)"/g)) {
      const [targetPath, hash] = href.split('#');
      if (!targetPath.endsWith('.html') && targetPath !== '/') continue;
      assert.ok(htmlByPath.has(targetPath), `${pathname} links to existing page ${href}`);
      if (hash) assert.ok(htmlByPath.get(targetPath).includes(`id="${hash}"`), `${pathname} links to existing section ${href}`);
    }
  }
  assert.match(htmlByPath.get('/updates.html'), /data-update-page-size="8"/);
  const taskIds = [...combinedHtml.matchAll(/\bdata-check-id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(taskIds.length, 21, 'task IDs must occur exactly once across the served guide pages');
  assert.equal(new Set(taskIds).size, 21, 'task IDs must be unique across the served guide pages');
  assert.deepEqual(taskIds.slice().sort(), expectedTaskIds);
  assert.match(servedHtml[0], /\bdata-update-limit="3"/, 'the homepage must cap its compact official feed at three items');

  for (const [pathname, contentType, marker] of [
    ['/styles.css', 'text/css; charset=utf-8', ':root'],
    ['/app.js', 'text/javascript; charset=utf-8', 'getTimelineState']
  ]) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, `${pathname} must return 200`);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.match(await response.text(), new RegExp(marker));
  }
});

test('does not expose paths outside the site root', async (t) => {
  assert.equal(typeof createServer, 'function', 'createServer must be exported');

  const server = createServer(path.resolve(__dirname, '..'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/missing-file.txt`);
  assert.equal(response.status, 404);
});

test('the Windows launcher explicit port overrides an inherited PORT', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  const inheritedPort = await getUnusedPort([requestedPort]);
  assert.notEqual(requestedPort, inheritedPort);
  await assertPortFreeBeforeLaunch(requestedPort);

  const result = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory, env: { ...process.env, PORT: String(inheritedPort) } }
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const health = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${requestedPort}/api/health`);
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  });
  assert.equal(health.product, 'hainanu-2027-kaoyan-guide');
  await assert.rejects(fetch(`http://127.0.0.1:${inheritedPort}/api/health`));
});

test('Windows lifecycle treats an identified live seed service as running without claiming data readiness', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t, liveButNotReadyServerSource);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchScript = path.join(projectDirectory, 'scripts', 'launch.ps1');

  const first = await runPowerShellFile(launchScript, ['-Port', requestedPort, '-NoBrowser'], { cwd: projectDirectory });
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  const firstPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  recordTestProcess(path.join(projectDirectory, 'server.cjs'), firstPid);

  const second = await runPowerShellFile(launchScript, ['-Port', requestedPort, '-NoBrowser'], { cwd: projectDirectory });
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(Number(fs.readFileSync(pidPath, 'utf8').trim()), firstPid);
  assert.equal(getExactEntryProcesses(path.join(projectDirectory, 'server.cjs')).length, 1);

  const health = await (await fetch(`http://127.0.0.1:${requestedPort}/api/health`)).json();
  assert.deepEqual({ live: health.live, ready: health.ready }, { live: true, ready: false });
});

test('Windows stop keeps a stale PID when the identified guide is live but not data-ready', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t, liveButNotReadyServerSource);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const serverScript = path.join(projectDirectory, 'server.cjs');
  const liveServer = spawn(process.execPath, [serverScript], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: String(requestedPort) },
    stdio: 'ignore',
    windowsHide: true
  });
  recordTestProcess(serverScript, liveServer.pid);
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${requestedPort}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  });

  const pidPath = getPidPath(projectDirectory, requestedPort);
  fs.writeFileSync(pidPath, '2147483000\n');
  const result = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'stop.ps1'),
    ['-Port', requestedPort],
    { cwd: projectDirectory }
  );

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /still (?:healthy|live)|guide is still/i);
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), '2147483000');
  assert.notEqual(getProcessInfo(liveServer.pid), null);
});

test('concurrent Windows launches share one owned service and both succeed', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchScript = path.join(projectDirectory, 'scripts', 'launch.ps1');

  const results = await Promise.all([
    runPowerShellFile(launchScript, ['-Port', requestedPort, '-NoBrowser'], { cwd: projectDirectory }),
    runPowerShellFile(launchScript, ['-Port', requestedPort, '-NoBrowser'], { cwd: projectDirectory })
  ]);

  assert.deepEqual(results.map(({ code }) => code), [0, 0], JSON.stringify(results));
  const ownedPids = getExactEntryProcesses(path.join(projectDirectory, 'server.cjs'))
    .map(({ ProcessId }) => Number(ProcessId));
  assert.equal(ownedPids.length, 1, `expected one owned service, found ${ownedPids.join(', ')}`);
  assert.equal(Number(fs.readFileSync(getPidPath(projectDirectory, requestedPort), 'utf8').trim()), ownedPids[0]);
});

test('the Windows launcher holds a Global project-and-port mutex through readiness', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t, delayedReadyServerSource);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchPromise = runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );

  await waitFor(() => fs.existsSync(getPidPath(projectDirectory, requestedPort)), 5000);
  const probe = canOpenNamedMutex(getGlobalMutexName(projectDirectory, requestedPort));
  const launchResult = await launchPromise;

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.equal(launchResult.code, 0, launchResult.stderr || launchResult.stdout);
});

test('non-default ports use independent port-specific PID files', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const firstPort = await getUnusedPort();
  const secondPort = await getUnusedPort([firstPort]);
  assert.notEqual(firstPort, secondPort);
  await assertPortFreeBeforeLaunch(firstPort);
  await assertPortFreeBeforeLaunch(secondPort);

  const launchScript = path.join(projectDirectory, 'scripts', 'launch.ps1');
  const firstResult = await runPowerShellFile(
    launchScript,
    ['-Port', firstPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  const secondResult = await runPowerShellFile(
    launchScript,
    ['-Port', secondPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);

  const firstPidPath = path.join(projectDirectory, 'data', `server-${firstPort}.pid`);
  const secondPidPath = path.join(projectDirectory, 'data', `server-${secondPort}.pid`);
  assert.equal(fs.existsSync(firstPidPath), true);
  assert.equal(fs.existsSync(secondPidPath), true);
  assert.notEqual(fs.readFileSync(firstPidPath, 'utf8').trim(), fs.readFileSync(secondPidPath, 'utf8').trim());
  assert.equal(fs.existsSync(path.join(projectDirectory, 'data', 'server.pid')), false);
});

test('a failed Windows launch preserves a PID replaced by another writer', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t, shortLivedServerSource);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  const launchPromise = runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );

  await waitFor(() => fs.existsSync(pidPath) && /^\d+$/.test(fs.readFileSync(pidPath, 'utf8').trim()));
  fs.writeFileSync(pidPath, '999999\n');
  const result = await launchPromise;

  assert.notEqual(result.code, 0, 'the intentionally short-lived server must fail readiness');
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), '999999');
});

test('PID publication failure terminates and waits for the launched child', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  fs.mkdirSync(pidPath);

  const result = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );

  assert.notEqual(result.code, 0, 'the injected PID publication failure must fail launch');
  assert.match(`${result.stdout}\n${result.stderr}`, /PID|Replace|directory|path/i);
  assert.deepEqual(getExactEntryProcesses(path.join(projectDirectory, 'server.cjs')), []);
});

test('the Windows launcher atomically replaces an existing port PID file', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  fs.writeFileSync(pidPath, '2147483000\n');

  const result = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const ownedPids = getExactEntryProcesses(path.join(projectDirectory, 'server.cjs'))
    .map(({ ProcessId }) => Number(ProcessId));
  assert.equal(ownedPids.length, 1);
  assert.equal(Number(fs.readFileSync(pidPath, 'utf8').trim()), ownedPids[0]);
  const pidArtifacts = fs.readdirSync(path.join(projectDirectory, 'data'))
    .filter((name) => /^server\.pid\..+\.(?:tmp|bak)$/.test(name));
  assert.deepEqual(pidArtifacts, []);
});

test('the Windows launcher retains only the newest fourteen log pairs', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const dataDirectory = path.join(projectDirectory, 'data');
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  for (let index = 1; index <= 15; index += 1) {
    const stamp = `20240101-0000${String(index).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dataDirectory, `server-${requestedPort}-${stamp}-seed${index}.log`), `stdout-${index}`);
    fs.writeFileSync(path.join(dataDirectory, `server-${requestedPort}-${stamp}-seed${index}.error.log`), `stderr-${index}`);
  }

  const result = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const stdoutLogs = fs.readdirSync(dataDirectory).filter((name) => new RegExp(`^server-${requestedPort}-.+(?<!\\.error)\\.log$`).test(name));
  const stderrLogs = fs.readdirSync(dataDirectory).filter((name) => new RegExp(`^server-${requestedPort}-.+\\.error\\.log$`).test(name));
  assert.equal(stdoutLogs.length, 14);
  assert.equal(stderrLogs.length, 14);
  assert.equal(fs.existsSync(path.join(dataDirectory, `server-${requestedPort}-20240101-000001-seed1.log`)), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, `server-${requestedPort}-20240101-000001-seed1.error.log`)), false);
});

test('the Windows launcher cleans orphaned log files alongside complete pairs', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const dataDirectory = path.join(projectDirectory, 'data');
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  for (let index = 1; index <= 13; index += 1) {
    const stamp = `20240102-0000${String(index).padStart(2, '0')}`;
    const standardPath = path.join(dataDirectory, `server-${requestedPort}-${stamp}-seed${index}.log`);
    const errorPath = path.join(dataDirectory, `server-${requestedPort}-${stamp}-seed${index}.error.log`);
    fs.writeFileSync(standardPath, `stdout-${index}`);
    fs.writeFileSync(errorPath, `stderr-${index}`);
    const oldTime = new Date(Date.UTC(2024, 0, 2, 0, 0, index));
    fs.utimesSync(standardPath, oldTime, oldTime);
    fs.utimesSync(errorPath, oldTime, oldTime);
  }
  const orphanLog = path.join(dataDirectory, 'server-20240101-000001-orphan.log');
  const orphanErrorLog = path.join(dataDirectory, 'server-20240101-000001-dangling.error.log');
  fs.writeFileSync(orphanLog, 'orphan stdout without an error counterpart');
  fs.writeFileSync(orphanErrorLog, 'orphan stderr without a standard counterpart');
  const oldestTime = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  fs.utimesSync(orphanLog, oldestTime, oldestTime);
  fs.utimesSync(orphanErrorLog, oldestTime, oldestTime);

  const result = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(orphanLog), false, 'the orphan standard log must be cleaned');
  assert.equal(fs.existsSync(orphanErrorLog), false, 'the orphan error log must be cleaned');
  const fileNames = fs.readdirSync(dataDirectory);
  const standardLogs = fileNames.filter((name) => name.startsWith('server-') && name.endsWith('.log') && !name.endsWith('.error.log'));
  const completePairs = standardLogs.filter((name) => fileNames.includes(`${name.slice(0, -4)}.error.log`));
  assert.equal(standardLogs.length, completePairs.length, `incomplete log pair: ${standardLogs.join(', ')}`);
  assert.equal(completePairs.length, 14, completePairs.join(', '));
});

test('browser launch failure after readiness is a warning, not launch failure', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const runnerPath = path.join(projectDirectory, 'scripts', 'browser-failure-runner.ps1');
  fs.writeFileSync(runnerPath, String.raw`
function Start-Process {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)][string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory,
        [System.Diagnostics.ProcessWindowStyle]$WindowStyle,
        [string]$RedirectStandardOutput,
        [string]$RedirectStandardError,
        [switch]$PassThru
    )
    if ($FilePath -match '^https?://') {
        throw 'simulated browser launch failure'
    }
    Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
}
& (Join-Path $PSScriptRoot 'launch.ps1') -Port ${requestedPort}
`);

  const result = await runPowerShellFile(runnerPath, [], { cwd: projectDirectory });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /simulated browser launch failure/i);
  const response = await fetch(`http://127.0.0.1:${requestedPort}/api/health`);
  assert.equal(response.ok, true);
});

test('Windows stop keeps the PID when the managed service remains healthy', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t, parentWithWorkerServerSource);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  assert.equal(launchResult.code, 0, launchResult.stderr || launchResult.stdout);

  const pidPath = getPidPath(projectDirectory, requestedPort);
  const managedPid = fs.readFileSync(pidPath, 'utf8').trim();
  const stopResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'stop.ps1'),
    ['-Port', requestedPort],
    { cwd: projectDirectory }
  );

  assert.notEqual(stopResult.code, 0, 'stop must fail while the guide health endpoint remains ready');
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), managedPid);
  const response = await fetch(`http://127.0.0.1:${requestedPort}/api/health`);
  assert.equal(response.ok, true);
});

test('Windows stop removes PID only after process exit and failed health probe', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  assert.equal(launchResult.code, 0, launchResult.stderr || launchResult.stdout);

  const pidPath = getPidPath(projectDirectory, requestedPort);
  const managedPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  const stopResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'stop.ps1'),
    ['-Port', requestedPort],
    { cwd: projectDirectory }
  );

  assert.equal(stopResult.code, 0, stopResult.stderr || stopResult.stdout);
  assert.equal(getProcessInfo(managedPid), null);
  assert.equal(fs.existsSync(pidPath), false);
  await assert.rejects(fetch(`http://127.0.0.1:${requestedPort}/api/health`));
});

test('Windows stop holds the same Global lifecycle mutex through cleanup', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  assert.equal(launchResult.code, 0, launchResult.stderr || launchResult.stdout);

  const holder = holdNamedMutex(getGlobalMutexName(projectDirectory, requestedPort), 10000);
  await holder.ready;
  let stopSettled = false;
  const stopPromise = runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'stop.ps1'),
    ['-Port', requestedPort],
    { cwd: projectDirectory }
  ).then((result) => {
    stopSettled = true;
    return result;
  });

  let stopResult;
  try {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(stopSettled, false, 'stop must wait while the shared lifecycle mutex is held');
    const response = await fetch(`http://127.0.0.1:${requestedPort}/api/health`);
    assert.equal(response.ok, true);
  } finally {
    await holder.exited;
    stopResult = await stopPromise;
  }
  assert.equal(stopResult.code, 0, stopResult.stderr || stopResult.stdout);
  assert.equal(fs.existsSync(getPidPath(projectDirectory, requestedPort)), false);
});

test('concurrent stop and replacement launch cannot delete the new PID', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchScript = path.join(projectDirectory, 'scripts', 'launch.ps1');
  const stopScript = path.join(projectDirectory, 'scripts', 'stop.ps1');
  const pidPath = getPidPath(projectDirectory, requestedPort);
  const firstLaunch = await runPowerShellFile(
    launchScript,
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  assert.equal(firstLaunch.code, 0, firstLaunch.stderr || firstLaunch.stdout);

  const removalNeedle = '        Remove-Item -LiteralPath $pidPath -Force -ErrorAction Stop';
  const stopSource = fs.readFileSync(stopScript, 'utf8');
  assert.equal(stopSource.split(removalNeedle).length - 1, 1, 'race injection point must be unique');
  const raceInjection = String.raw`
        $replacementParameters = @{
            FilePath = '${powershell}'
            ArgumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${launchScript}', '-Port', '${requestedPort}', '-NoBrowser')
            WorkingDirectory = '${projectDirectory}'
            WindowStyle = 'Hidden'
            PassThru = $true
        }
        [void](Microsoft.PowerShell.Management\Start-Process @replacementParameters)
        $raceDeadline = [DateTime]::UtcNow.AddSeconds(2)
        while ([DateTime]::UtcNow -lt $raceDeadline) {
            if ((Get-Content -LiteralPath $pidPath -Raw).Trim() -ne $currentPid) { break }
            Start-Sleep -Milliseconds 50
        }
`;
  fs.writeFileSync(stopScript, stopSource.replace(removalNeedle, `${raceInjection}\n${removalNeedle}`));

  const raceResult = await runPowerShellFile(stopScript, ['-Port', requestedPort], { cwd: projectDirectory });
  assert.equal(raceResult.code, 0, `${raceResult.stdout}\n${raceResult.stderr}`);
  await waitFor(async () => {
    if (!fs.existsSync(pidPath)) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${requestedPort}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 20000);
  recordExactEntryProcesses(path.join(projectDirectory, 'server.cjs'));
  const ownedPids = getExactEntryProcesses(path.join(projectDirectory, 'server.cjs'))
    .map(({ ProcessId }) => Number(ProcessId));
  assert.equal(ownedPids.length, 1);
  assert.equal(Number(fs.readFileSync(pidPath, 'utf8').trim()), ownedPids[0]);
});

test('Windows stop distinguishes a CIM query error from process absence', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const queryErrorProject = createLifecycleProject(t);
  const queryErrorPort = await getUnusedPort();
  const queryErrorPidPath = getPidPath(queryErrorProject, queryErrorPort);
  fs.writeFileSync(queryErrorPidPath, '2147483000\n');
  const queryErrorRunner = path.join(queryErrorProject, 'scripts', 'cim-error-runner.ps1');
  fs.writeFileSync(queryErrorRunner, String.raw`
function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)]$ClassName, [string]$Filter)
    throw 'simulated CIM query failure'
}
& (Join-Path $PSScriptRoot 'stop.ps1') -Port ${queryErrorPort}
`);

  const queryErrorResult = await runPowerShellFile(queryErrorRunner, [], { cwd: queryErrorProject });
  assert.notEqual(queryErrorResult.code, 0);
  assert.match(`${queryErrorResult.stdout}\n${queryErrorResult.stderr}`, /Could not query PID.*simulated CIM query failure/is);
  assert.equal(fs.readFileSync(queryErrorPidPath, 'utf8').trim(), '2147483000');

  const absentProject = createLifecycleProject(t);
  const absentPort = await getUnusedPort();
  const absentPidPath = getPidPath(absentProject, absentPort);
  fs.writeFileSync(absentPidPath, '2147483000\n');
  const absentResult = await runPowerShellFile(
    path.join(absentProject, 'scripts', 'stop.ps1'),
    ['-Port', absentPort],
    { cwd: absentProject }
  );
  assert.equal(absentResult.code, 0, absentResult.stderr || absentResult.stdout);
  assert.equal(fs.existsSync(absentPidPath), false);
});

test('default-port stop remains compatible with data/server.pid', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const defaultPidPath = getPidPath(projectDirectory, 4173);
  const wrongPortSpecificPath = path.join(projectDirectory, 'data', 'server-4173.pid');
  fs.writeFileSync(defaultPidPath, '111111\n');
  fs.writeFileSync(wrongPortSpecificPath, '222222\n');
  const runnerPath = path.join(projectDirectory, 'scripts', 'default-pid-runner.ps1');
  fs.writeFileSync(runnerPath, String.raw`
function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)]$ClassName, [string]$Filter)
    throw "simulated default PID query: $Filter"
}
& (Join-Path $PSScriptRoot 'stop.ps1')
`);

  const result = await runPowerShellFile(runnerPath, [], { cwd: projectDirectory });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Could not query PID 111111.*simulated default PID query/is);
  assert.equal(fs.readFileSync(defaultPidPath, 'utf8').trim(), '111111');
  assert.equal(fs.readFileSync(wrongPortSpecificPath, 'utf8').trim(), '222222');
});

test('Windows stop keeps PID when the fixed native process object exits before Kill', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const launchResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'launch.ps1'),
    ['-Port', requestedPort, '-NoBrowser'],
    { cwd: projectDirectory }
  );
  assert.equal(launchResult.code, 0, launchResult.stderr || launchResult.stdout);

  const pidPath = getPidPath(projectDirectory, requestedPort);
  const managedPid = fs.readFileSync(pidPath, 'utf8').trim();
  const runnerPath = path.join(projectDirectory, 'scripts', 'native-kill-race-runner.ps1');
  fs.writeFileSync(runnerPath, String.raw`
$script:cimCalls = 0
$script:realGetCim = Get-Command Get-CimInstance -CommandType Cmdlet
function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)]$ClassName, [string]$Filter)
    $script:cimCalls += 1
    $actual = & "$($script:realGetCim.ModuleName)\Get-CimInstance" @PSBoundParameters
    if ($script:cimCalls -eq 2) {
        $raced = [System.Diagnostics.Process]::GetProcessById($actual.ProcessId)
        try {
            $raced.Kill()
            [void]$raced.WaitForExit(5000)
        } finally {
            $raced.Dispose()
        }
    }
    return $actual
}
& (Join-Path $PSScriptRoot 'stop.ps1') -Port ${requestedPort}
`);

  const stopResult = await runPowerShellFile(runnerPath, [], { cwd: projectDirectory });
  assert.notEqual(stopResult.code, 0);
  assert.match(`${stopResult.stdout}\n${stopResult.stderr}`, /Could not terminate PID.*native process handle/is);
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), managedPid);
  assert.equal(getProcessInfo(Number(managedPid)), null, 'the injected race must end the owned child before Kill');
});

test('Windows stop requires the exact server script argument', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const lookalikeScript = path.join(projectDirectory, 'server.cjs.bak');
  fs.writeFileSync(lookalikeScript, 'setInterval(() => {}, 1000);\n');
  const lookalike = spawn(process.execPath, [lookalikeScript], {
    cwd: projectDirectory,
    stdio: 'ignore',
    windowsHide: true
  });
  await waitFor(() => getProcessInfo(lookalike.pid));
  recordTestProcess(lookalikeScript, lookalike.pid);
  t.after(async () => cleanupOwnedScript(lookalikeScript));

  const stopPort = await getUnusedPort();
  const pidPath = getPidPath(projectDirectory, stopPort);
  fs.writeFileSync(pidPath, `${lookalike.pid}\n`);
  const stopResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'stop.ps1'),
    ['-Port', stopPort],
    { cwd: projectDirectory }
  );

  assert.notEqual(stopResult.code, 0);
  assert.match(`${stopResult.stdout}\n${stopResult.stderr}`, /belongs to another process/i);
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(lookalike.pid));
  assert.notEqual(getProcessInfo(lookalike.pid), null);
});

test('Windows stop rejects server.cjs when it is only an ordinary Node argument', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const decoyScript = path.join(projectDirectory, 'other.cjs');
  const serverScript = path.join(projectDirectory, 'server.cjs');
  fs.writeFileSync(decoyScript, 'setInterval(() => {}, 1000);\n');
  const decoy = spawn(process.execPath, [decoyScript, serverScript], {
    cwd: projectDirectory,
    stdio: 'ignore',
    windowsHide: true
  });
  await waitFor(() => getProcessInfo(decoy.pid));
  recordTestProcess(decoyScript, decoy.pid);
  t.after(async () => cleanupOwnedScript(decoyScript));

  const stopPort = await getUnusedPort();
  const pidPath = getPidPath(projectDirectory, stopPort);
  fs.writeFileSync(pidPath, `${decoy.pid}\n`);
  const stopResult = await runPowerShellFile(
    path.join(projectDirectory, 'scripts', 'stop.ps1'),
    ['-Port', stopPort],
    { cwd: projectDirectory }
  );

  assert.notEqual(stopResult.code, 0);
  assert.match(`${stopResult.stdout}\n${stopResult.stderr}`, /belongs to another process/i);
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(decoy.pid));
  assert.notEqual(getProcessInfo(decoy.pid), null);
});

test('concurrent different-port launches use distinct log pairs and retain without deletion races', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const firstPort = await getUnusedPort();
  const secondPort = await getUnusedPort([firstPort]);
  await assertPortFreeBeforeLaunch(firstPort);
  await assertPortFreeBeforeLaunch(secondPort);
  const launchScript = path.join(projectDirectory, 'scripts', 'launch.ps1');
  const runners = [firstPort, secondPort].map((port) => {
    const runner = path.join(projectDirectory, 'scripts', `fixed-clock-${port}.ps1`);
    fs.writeFileSync(runner, String.raw`
function Get-Date { param([string]$Format) return '20260824-120000-000' }
& (Join-Path $PSScriptRoot 'launch.ps1') -Port ${port} -NoBrowser
`);
    return runner;
  });

  const results = await Promise.all(runners.map((runner) => runPowerShellFile(runner, [], { cwd: projectDirectory })));
  assert.deepEqual(results.map(({ code }) => code), [0, 0], JSON.stringify(results));

  const logNames = fs.readdirSync(path.join(projectDirectory, 'data')).filter((name) => /^server-\d+-.+\.(?:error\.)?log$/.test(name));
  assert.equal(logNames.length, 4, logNames.join(', '));
  assert.equal(new Set(logNames).size, 4, `log names collided: ${logNames.join(', ')}`);
  for (const port of [firstPort, secondPort]) {
    assert.equal(logNames.filter((name) => name.startsWith(`server-${port}-`)).length, 2, logNames.join(', '));
  }
});

test('concurrent different-port launches retain at most fourteen mixed legacy and port log pairs project-wide', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const dataDirectory = path.join(projectDirectory, 'data');
  const firstPort = await getUnusedPort();
  const secondPort = await getUnusedPort([firstPort]);
  const seedPort = await getUnusedPort([firstPort, secondPort]);
  await assertPortFreeBeforeLaunch(firstPort);
  await assertPortFreeBeforeLaunch(secondPort);

  for (let index = 1; index <= 16; index += 1) {
    const stamp = `20240101-0000${String(index).padStart(2, '0')}-000`;
    const prefix = index % 2 === 0
      ? `server-${seedPort}-${stamp}-seed${index}`
      : `server-${stamp}`;
    const stdoutPath = path.join(dataDirectory, `${prefix}.log`);
    const stderrPath = path.join(dataDirectory, `${prefix}.error.log`);
    fs.writeFileSync(stdoutPath, `stdout-${index}`);
    fs.writeFileSync(stderrPath, `stderr-${index}`);
    const oldTime = new Date(Date.UTC(2024, 0, 1, 0, 0, index));
    fs.utimesSync(stdoutPath, oldTime, oldTime);
    fs.utimesSync(stderrPath, oldTime, oldTime);
  }

  const runners = [firstPort, secondPort].map((port) => {
    const runner = path.join(projectDirectory, 'scripts', `mixed-retention-${port}.ps1`);
    fs.writeFileSync(runner, String.raw`
function Get-Date { param([string]$Format) return '20260824-130000-000' }
& (Join-Path $PSScriptRoot 'launch.ps1') -Port ${port} -NoBrowser
`);
    return runner;
  });
  const results = await Promise.all(runners.map((runner) => runPowerShellFile(runner, [], { cwd: projectDirectory })));
  assert.deepEqual(results.map(({ code }) => code), [0, 0], JSON.stringify(results));

  const fileNames = fs.readdirSync(dataDirectory);
  const standardLogs = fileNames.filter((name) => name.startsWith('server-') && name.endsWith('.log') && !name.endsWith('.error.log'));
  const completePairs = standardLogs.filter((name) => fileNames.includes(`${name.slice(0, -4)}.error.log`));
  assert.equal(standardLogs.length, completePairs.length, `incomplete log pair: ${standardLogs.join(', ')}`);
  assert.equal(completePairs.length, 14, completePairs.join(', '));
  assert.equal(new Set(completePairs).size, completePairs.length, `log names collided: ${completePairs.join(', ')}`);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'server-20240101-000001-000.log')), false, 'old legacy pair must be retained under the project-wide cap');
  for (const port of [firstPort, secondPort]) {
    assert.equal(completePairs.filter((name) => name.startsWith(`server-${port}-`)).length, 1, completePairs.join(', '));
  }
});

test('failed launch keeps its published PID when child cleanup cannot confirm exit', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t, 'setInterval(() => {}, 1000);\n');
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  const runnerPath = path.join(projectDirectory, 'scripts', 'cleanup-failure-runner.ps1');
  fs.writeFileSync(runnerPath, String.raw`
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id)
    throw 'simulated child cleanup termination failure'
}
& (Join-Path $PSScriptRoot 'launch.ps1') -Port ${requestedPort} -NoBrowser
`);

  const result = await runPowerShellFile(runnerPath, [], { cwd: projectDirectory });
  assert.notEqual(result.code, 0, 'the non-ready server must fail launch');
  assert.match(`${result.stdout}\n${result.stderr}`, /cleanup also failed|PID file was kept|did not exit/i);
  const managedPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  assert.ok(Number.isInteger(managedPid) && managedPid > 0, 'published PID must be retained');
  assert.notEqual(getProcessInfo(managedPid), null, 'the still-live child must remain identifiable for a later safe stop');
});

test('Windows stop rejects a second CIM result with a different creation time and keeps PID', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const serverScript = path.join(projectDirectory, 'server.cjs');
  const owned = spawn(process.execPath, [serverScript], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: String(requestedPort) },
    stdio: 'ignore',
    windowsHide: true
  });
  await waitFor(() => getProcessInfo(owned.pid));
  recordTestProcess(serverScript, owned.pid);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  fs.writeFileSync(pidPath, `${owned.pid}\n`);
  const runnerPath = path.join(projectDirectory, 'scripts', 'creation-time-changed-runner.ps1');
  fs.writeFileSync(runnerPath, String.raw`
$script:cimCalls = 0
$script:realGetCim = Get-Command Get-CimInstance -CommandType Cmdlet
function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)]$ClassName, [string]$Filter)
    $script:cimCalls += 1
    $actual = & "$($script:realGetCim.ModuleName)\Get-CimInstance" @PSBoundParameters
    if ($script:cimCalls -eq 1) { return $actual }
    [PSCustomObject]@{ ProcessId = $actual.ProcessId; Name = $actual.Name; CommandLine = $actual.CommandLine; CreationDate = '20990101000000.000000+000' }
}
& (Join-Path $PSScriptRoot 'stop.ps1') -Port ${requestedPort}
`);

  const result = await runPowerShellFile(runnerPath, [], { cwd: projectDirectory });
  assert.notEqual(result.code, 0, 'creation-time replacement must refuse termination');
  assert.match(`${result.stdout}\n${result.stderr}`, /identity changed|creation/i);
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(owned.pid));
  assert.notEqual(getProcessInfo(owned.pid), null);
});

test('Windows stop rejects a second CIM result with a missing creation time and keeps PID', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  const requestedPort = await getUnusedPort();
  await assertPortFreeBeforeLaunch(requestedPort);
  const serverScript = path.join(projectDirectory, 'server.cjs');
  const owned = spawn(process.execPath, [serverScript], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: String(requestedPort) },
    stdio: 'ignore',
    windowsHide: true
  });
  await waitFor(() => getProcessInfo(owned.pid));
  recordTestProcess(serverScript, owned.pid);
  const pidPath = getPidPath(projectDirectory, requestedPort);
  fs.writeFileSync(pidPath, `${owned.pid}\n`);
  const runnerPath = path.join(projectDirectory, 'scripts', 'creation-time-missing-runner.ps1');
  fs.writeFileSync(runnerPath, String.raw`
$script:cimCalls = 0
$script:realGetCim = Get-Command Get-CimInstance -CommandType Cmdlet
function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)]$ClassName, [string]$Filter)
    $script:cimCalls += 1
    $actual = & "$($script:realGetCim.ModuleName)\Get-CimInstance" @PSBoundParameters
    if ($script:cimCalls -eq 1) { return $actual }
    [PSCustomObject]@{ ProcessId = $actual.ProcessId; Name = $actual.Name; CommandLine = $actual.CommandLine; CreationDate = $null }
}
& (Join-Path $PSScriptRoot 'stop.ps1') -Port ${requestedPort}
`);

  const result = await runPowerShellFile(runnerPath, [], { cwd: projectDirectory });
  assert.notEqual(result.code, 0, 'missing second creation time must refuse termination');
  assert.match(`${result.stdout}\n${result.stderr}`, /identity changed|creation/i);
  assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(owned.pid));
  assert.notEqual(getProcessInfo(owned.pid), null);
});

test('Windows batch wrappers pass through PowerShell exit codes', {
  skip: !isWindowsPowerShellAvailable
}, async (t) => {
  const projectDirectory = createLifecycleProject(t);
  fs.copyFileSync(path.join(projectRoot, 'start-guide.cmd'), path.join(projectDirectory, 'start-guide.cmd'));
  fs.copyFileSync(path.join(projectRoot, 'stop-guide.cmd'), path.join(projectDirectory, 'stop-guide.cmd'));
  fs.writeFileSync(path.join(projectDirectory, 'scripts', 'launch.ps1'), 'exit 23\n');
  fs.writeFileSync(path.join(projectDirectory, 'scripts', 'stop.ps1'), 'exit 23\n');

  const [startResult, stopResult] = await Promise.all([
    runBatchFile(path.join(projectDirectory, 'start-guide.cmd'), { cwd: projectDirectory }),
    runBatchFile(path.join(projectDirectory, 'stop-guide.cmd'), { cwd: projectDirectory })
  ]);

  assert.equal(startResult.code, 23, startResult.stderr || startResult.stdout);
  assert.equal(stopResult.code, 23, stopResult.stderr || stopResult.stdout);
});
