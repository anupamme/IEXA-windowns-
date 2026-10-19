const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-jobs-retention-'));
process.env.IEXA_WORKSPACE = path.join(fixture, 'workspace');
fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
const backend = require('../dist/main/server');
const JOBS_FILE = path.join(process.env.IEXA_WORKSPACE, '.iexa-jobs.json');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const seeded = [];
let seq = 0;
function push(sessionId, status, ageMs) {
  seq += 1;
  const createdAt = now - ageMs;
  const live = status === 'running' || status === 'queued';
  seeded.push({
    id: `job_${seq}`, sessionId, kind: 'tool', toolName: 'shell_execute', title: `任务 ${seq}`,
    status, createdAt, ...(live ? { startedAt: createdAt } : { finishedAt: createdAt + 100 }),
  });
}
// One conversation can produce hundreds of jobs a day; two of them are still
// running and must survive every purge. Entries are appended oldest-first, the
// order the server writes them in.
for (let i = 0; i < 400; i += 1) push('sess_a', 'completed', (400 - i) * 1000);
push('sess_a', 'running', 2000);
push('sess_a', 'queued', 1000);
for (let i = 0; i < 210; i += 1) push('sess_b', 'completed', 60000 + (210 - i) * 1000);
for (let i = 0; i < 40; i += 1) push('sess_b', 'completed', 8 * DAY + (40 - i) * 1000);
push('sess_c', 'failed', 9 * DAY);
fs.writeFileSync(JOBS_FILE, JSON.stringify(seeded));

let server, port, token;
function request(route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}
const readDisk = () => JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
const settledIn = (jobs, sessionId) => jobs.filter((job) => job.sessionId === sessionId && job.status !== 'running' && job.status !== 'queued').length;

test.before(async () => {
  server = await backend.startServer(0, false);
  port = server.address().port;
  token = backend.getServerCredentials(server).token;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('opening the task center prunes expired and surplus records to disk', async () => {
  assert.equal(readDisk().length, seeded.length, 'the fixture is untouched before the first read');

  const all = await request('/api/jobs');
  assert.equal(all.status, 200);
  const jobs = all.data.jobs;
  assert.equal(jobs.length, 402, '200 settled per conversation + the two live rows');
  assert.deepEqual(all.data.retention, { days: 7, perSession: 200, total: 500 });

  // Live rows survive pruning regardless of age or count.
  assert.equal(jobs.filter((job) => job.status === 'running' || job.status === 'queued').length, 2);
  // Each conversation keeps its newest settled entries only.
  assert.equal(settledIn(jobs, 'sess_a'), 200);
  assert.equal(settledIn(jobs, 'sess_b'), 200);
  assert.equal(jobs.filter((job) => job.sessionId === 'sess_c').length, 0, 'a conversation with only expired rows disappears');
  // Nothing settled older than the window is left.
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'queued') continue;
    assert.ok(now - job.finishedAt <= 7 * DAY, `expired job ${job.id} survived`);
  }
  // The newest entry survives, the oldest of the 400 does not.
  assert.ok(jobs.some((job) => job.id === 'job_400'));
  assert.ok(!jobs.some((job) => job.id === 'job_1'));

  const disk = readDisk();
  assert.equal(disk.length, 402, 'the pruned set is written back at startup, not held in memory only');
});

test('a scoped purge leaves other conversations and running jobs alone', async () => {
  const cleared = await request('/api/jobs?sessionId=sess_a', 'DELETE');
  assert.equal(cleared.status, 200);
  assert.deepEqual({ removed: cleared.data.removed, remaining: cleared.data.remaining }, { removed: 200, remaining: 202 });

  const sessionA = (await request('/api/jobs?sessionId=sess_a')).data.jobs;
  assert.deepEqual(sessionA.map((job) => job.status).sort(), ['queued', 'running'], 'only the live rows remain');
  assert.equal((await request('/api/jobs?sessionId=sess_b')).data.jobs.length, 200, 'the other conversation is untouched');
  assert.equal(readDisk().length, 202, 'the purge is persisted immediately');

  // The running row is still usable: later updates must find it.
  const again = await request('/api/jobs?sessionId=sess_a', 'DELETE');
  assert.deepEqual({ removed: again.data.removed, remaining: again.data.remaining }, { removed: 0, remaining: 202 });
});

test('a global purge keeps only what is still executing', async () => {
  const cleared = await request('/api/jobs', 'DELETE');
  assert.equal(cleared.status, 200);
  assert.deepEqual({ removed: cleared.data.removed, remaining: cleared.data.remaining }, { removed: 200, remaining: 2 });

  const jobs = (await request('/api/jobs')).data.jobs;
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.status === 'running' || job.status === 'queued'));
  assert.equal(readDisk().length, 2);

  // Idempotent: a second click on an already clean trail reports nothing removed.
  const repeat = await request('/api/jobs', 'DELETE');
  assert.deepEqual({ removed: repeat.data.removed, remaining: repeat.data.remaining }, { removed: 0, remaining: 2 });
});
