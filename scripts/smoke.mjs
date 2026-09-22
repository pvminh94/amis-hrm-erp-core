/**
 * ============================================================================
 * SMOKE TEST — chạy trên BẢN BUILD THẬT bằng `node` thuần
 * ============================================================================
 *
 * Vì sao cần file này dù đã có 310 unit test?
 *
 * Vitest/Vite tự chuyển đổi module và TỰ TRẢI `default` của module CJS ra
 * namespace. Node thật thì KHÔNG. Kết quả: code dùng `await import('bcryptjs')`
 * rồi gọi `.hash()` chạy xanh trong test nhưng nổ "bcrypt.hash is not a
 * function" khi chạy `node dist/...` — tức là hỏng luôn đăng nhập production.
 *
 * Nên file này import thẳng từ `dist/`, không qua bất kỳ transformer nào.
 * Chạy SAU khi build:   npm run build && npm run smoke
 *
 * Không cần PostgreSQL/Redis — chỉ kiểm những gì không chạm DB.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${err.message}`);
  }
}

const DIST = new URL('../dist/', import.meta.url).href;

// ---------------------------------------------------------------------------
console.log('\n\u001b[1mSMOKE TEST — bản build production (node thuần)\u001b[0m\n');

console.log('\u001b[1m1. Crypto (bcrypt + AES-256-GCM)\u001b[0m');
const crypto = await import(`${DIST}src/infra/crypto/crypto.js`);

await check('hashPassword sinh ra bcrypt hash hợp lệ', async () => {
  const h = await crypto.hashPassword('Amis@123456', 10);
  assert.match(h, /^\$2[aby]\$10\$/, `hash sai định dạng: ${h}`);
});

await check('verifyPassword đúng mật khẩu → true', async () => {
  const h = await crypto.hashPassword('Amis@123456', 10);
  assert.equal(await crypto.verifyPassword('Amis@123456', h), true);
});

await check('verifyPassword sai mật khẩu → false', async () => {
  const h = await crypto.hashPassword('Amis@123456', 10);
  assert.equal(await crypto.verifyPassword('sai-mat-khau', h), false);
});

await check('AES-256-GCM mã hoá/giải mã số tài khoản ngân hàng', async () => {
  const key = Buffer.from('00'.repeat(32), 'hex');
  const enc = crypto.encrypt('0071000123456', key);
  assert.notEqual(enc.cipher, '0071000123456');
  assert.equal(crypto.decrypt(enc.cipher, key), '0071000123456');
});

await check('AES-GCM phát hiện bản mã bị sửa (tamper detection)', async () => {
  const key = Buffer.from('00'.repeat(32), 'hex');
  const enc = crypto.encrypt('du-lieu-nhay-cam', key);
  const tampered = enc.cipher.slice(0, -4) + 'AAAA';
  assert.throws(() => crypto.decrypt(tampered, key));
});

// ---------------------------------------------------------------------------
console.log('\n\u001b[1m2. Engine lương (domain thuần)\u001b[0m');
const { calculatePayroll } = await import(`${DIST}src/domain/payroll.js`);

await check('lương 25M/30M, 26 ngày, 2 phụ thuộc → gross 25.780.000, PIT 105.000', () => {
  const r = calculatePayroll({
    employeeId: 'e1',
    employeeCode: 'NV0001',
    fullName: 'Test',
    costAccount: '6422',
    contract: { baseSalary: 25_000_000, contractSalary: 30_000_000, maxKpiSalary: 0 },
    insurance: { wageRegion: 'I' },
    attendance: { workedDays: 26, scheduledDays: 26 },
    dependents: 2,
  }, { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' });

  assert.equal(r.gross, 25_780_000, `gross = ${r.gross}`);
  assert.equal(r.insurance.employee.si, 2_400_000, `si = ${r.insurance.employee.si}`);
  assert.equal(r.totalInsuranceEmployee, 3_150_000);
  assert.equal(r.pitAmount, 105_000, `PIT = ${r.pitAmount}`);
});

await check('thiếu trường chấm công → KHÔNG được trả về lương 0đ', () => {
  // Bug từng có: thiếu paidLeaveDays => NaN => gross 0 trong im lặng
  const r = calculatePayroll({
    employeeId: 'e2', employeeCode: 'NV0002', fullName: 'Test', costAccount: '6422',
    contract: { baseSalary: 25_000_000, contractSalary: 30_000_000, maxKpiSalary: 0 },
    insurance: { wageRegion: 'I' },
    attendance: { workedDays: 26, scheduledDays: 26 },   // cố tình thiếu các trường khác
    dependents: 2,
  }, { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' });
  assert.equal(r.prorateRatio, 1, `prorateRatio = ${r.prorateRatio}`);
  assert.ok(r.gross > 0, `gross = ${r.gross} — lương 0đ trong im lặng`);
});

await check('giá trị NaN trong attendance → NÉM LỖI chứ không tính ra 0đ', () => {
  assert.throws(() => calculatePayroll({
    employeeId: 'e3', employeeCode: 'NV0003', fullName: 'Test', costAccount: '6422',
    contract: { baseSalary: 25_000_000, contractSalary: 30_000_000, maxKpiSalary: 0 },
    insurance: { wageRegion: 'I' },
    attendance: { workedDays: 26, scheduledDays: 26, nightHours: NaN },
    dependents: 0,
  }, { periodEnd: '2025-06-30' }), /không phải số hữu hạn/);
});

await check('OT 150% ngày thường tính đúng', () => {
  const r = calculatePayroll({
    employeeId: 'e2',
    employeeCode: 'NV0002',
    fullName: 'Test',
    costAccount: '6422',
    contract: { baseSalary: 20_800_000, contractSalary: 20_800_000, maxKpiSalary: 0 },
    insurance: { wageRegion: 'I' },
    attendance: { workedDays: 26, scheduledDays: 26, otWeekdayHours: 4 },
    dependents: 0,
  }, { periodEnd: '2026-03-31', standardWorkDays: 26 });

  const ot = r.earnings.find((e) => e.code === 'OT_WEEKDAY');
  assert.ok(ot, 'thiếu khoản OT_WEEKDAY');
  // hourlyRate = 20.800.000/26/8 = 100.000 → 4h × 150% = 600.000
  assert.equal(ot.amount, 600_000, `OT = ${ot.amount}, mong đợi 600000`);
});

// ---------------------------------------------------------------------------
console.log('\n\u001b[1m3. Bút toán kế toán kép\u001b[0m');
const { buildGlJournalsFromAmounts } = await import(`${DIST}src/application/workers/handlers.js`);

await check('mọi bút toán cân Nợ = Có', () => {
  const journals = buildGlJournalsFromAmounts([{
    employeeId: 'e1', departmentCode: 'KD', gross: 25_780_000,
    siEmployee: 2_062_400, hiEmployee: 386_700, uiEmployee: 257_800, pit: 105_000,
    siEmployer: 4_382_600, hiEmployer: 773_400, uiEmployer: 257_800, wciEmployer: 128_900,
    net: 22_968_100, otherDeductions: [],
  }], { entryNoPrefix: 'SMOKE', date: '2026-03-31', payRunId: 'p1', periodLabel: '03/2026' });

  assert.ok(journals.length > 0, 'không sinh bút toán nào');
  for (const j of journals) {
    const d = j.lines.reduce((a, l) => a + (l.debit ?? 0), 0);
    const c = j.lines.reduce((a, l) => a + (l.credit ?? 0), 0);
    assert.equal(d, c, `${j.entryNo} lệch: Nợ ${d} ≠ Có ${c}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n\u001b[1m4. Server HTTP (boot thật, gọi thật)\u001b[0m');
const { createApp } = await import(`${DIST}src/main.js`);
const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;

const req = (method, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });

await check('GET /health → 200', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).status, 'ok');
});

await check('helmet gắn header bảo mật', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(r.headers['x-powered-by'], undefined);
});

await check('origin ngoài whitelist → 403 (không phải 500)', async () => {
  const r = await req('GET', '/health', { Origin: 'http://evil.example.com' });
  assert.equal(r.status, 403, `nhận ${r.status}`);
});

await check('không token → 401', async () => {
  const r = await req('GET', '/api/v1/auth/me');
  assert.equal(r.status, 401);
});

await check('webhook thiết bị KHÔNG đòi JWT (không trả 401)', async () => {
  const r = await req('POST', '/api/v1/attendance/devices/adms?sn=SMOKE-01', {
    'Content-Type': 'text/plain',
  });
  assert.notEqual(r.status, 401, 'webhook thiết bị bị chặn bởi JWT — chấm công từ máy sẽ chết');
});

await check('thiếu tham số sn → 400 rõ ràng', async () => {
  const r = await req('POST', '/api/v1/attendance/devices/adms', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 400);
});

server.close();

// ---------------------------------------------------------------------------
console.log('');
if (failures.length > 0) {
  console.log(`\u001b[31m\u001b[1mTHẤT BẠI: ${failures.length}/${passed + failures.length}\u001b[0m`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
console.log(`\u001b[32m\u001b[1mOK — ${passed} kiểm tra trên bản build production\u001b[0m`);
console.log('');
