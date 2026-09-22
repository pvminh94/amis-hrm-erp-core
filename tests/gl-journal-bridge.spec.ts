/**
 * ============================================================================
 * TEST — CẦU NỐI BÚT TOÁN (domain gl-bridge ↔ worker)
 * ============================================================================
 *
 * `buildGlJournalsFromAmounts` là hàm worker dùng để sinh bút toán từ số liệu
 * lương đã chốt. Nó phải giữ được hai ràng buộc mà kế toán coi là bất khả xâm
 * phạm: mỗi bút toán cân Nợ = Có, và tổng Nợ cả kỳ = tổng Có cả kỳ.
 */

import { describe, expect, it } from 'vitest';

import { buildGlJournalsFromAmounts } from '../src/application/workers/handlers.js';
import { reconcilePayableAccount, type GlEmployeeAmounts } from '../src/domain/gl-bridge.js';

const CFG = {
  entryNoPrefix: 'JVPR202603',
  date: '2026-03-31',
  payRunId: 'run-1',
  periodLabel: 'Kỳ lương 03/2026',
  costAccountByDepartment: { KD: '6421', HCNS: '6422', SX: '154' },
  defaultCostAccount: '6422',
} as const;

/** Một nhân viên điển hình: lương 25.780.000, 2 người phụ thuộc */
const empA: GlEmployeeAmounts = {
  employeeId: 'e1',
  departmentCode: 'KD',
  gross: 25_780_000,
  siEmployee: 2_062_400,
  hiEmployee: 386_700,
  uiEmployee: 257_800,
  pit: 105_000,
  siEmployer: 4_382_600,
  hiEmployer: 773_400,
  uiEmployer: 257_800,
  wciEmployer: 128_900,
  net: 22_968_100,
  otherDeductions: [],
};

const empB: GlEmployeeAmounts = {
  employeeId: 'e2',
  departmentCode: 'SX',
  gross: 9_000_000,
  siEmployee: 720_000,
  hiEmployee: 135_000,
  uiEmployee: 90_000,
  pit: 0,
  siEmployer: 1_530_000,
  hiEmployer: 270_000,
  uiEmployer: 90_000,
  wciEmployer: 45_000,
  net: 8_055_000,
  otherDeductions: [{ code: 'ADVANCE', amount: 0 }],
};

describe('buildGlJournalsFromAmounts — sinh bút toán từ số liệu lương', () => {
  it('sinh bút toán cho từng nhân viên (không gộp, để truy vết được)', () => {
    const journals = buildGlJournalsFromAmounts([empA, empB], CFG);
    expect(journals.length).toBeGreaterThan(2);
    // entryNo phải duy nhất — trùng là đụng ràng buộc UNIQUE trong DB
    const nos = journals.map((j) => j.entryNo);
    expect(new Set(nos).size).toBe(nos.length);
  });

  it('MỌI bút toán đều cân Nợ = Có', () => {
    const journals = buildGlJournalsFromAmounts([empA, empB], CFG);
    for (const j of journals) {
      const debit = j.lines.reduce((a, l) => a + (l.debit ?? 0), 0);
      const credit = j.lines.reduce((a, l) => a + (l.credit ?? 0), 0);
      expect(debit, `${j.entryNo} lệch Nợ/Có`).toBe(credit);
      expect(j.lines.length).toBeGreaterThan(0);
    }
  });

  it('tổng Nợ cả kỳ = tổng Có cả kỳ', () => {
    const journals = buildGlJournalsFromAmounts([empA, empB], CFG);
    const debit = journals.flatMap((j) => j.lines).reduce((a, l) => a + (l.debit ?? 0), 0);
    const credit = journals.flatMap((j) => j.lines).reduce((a, l) => a + (l.credit ?? 0), 0);
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);
  });

  it('dùng đúng TK chi phí theo phòng ban (6421 bán hàng / 154 sản xuất)', () => {
    const journals = buildGlJournalsFromAmounts([empA, empB], CFG);
    const accounts = new Set(journals.flatMap((j) => j.lines).map((l) => l.accountCode));
    expect(accounts.has('6421')).toBe(true); // phòng Kinh doanh
    expect(accounts.has('154')).toBe(true); // Xưởng sản xuất
  });

  it('ghi đủ các TK bắt buộc: 334, 3383, 3384, 3386, 3335, 1121', () => {
    const journals = buildGlJournalsFromAmounts([empA], CFG);
    const accounts = new Set(journals.flatMap((j) => j.lines).map((l) => l.accountCode));
    for (const must of ['334', '3383', '3384', '3386', '3335', '1121']) {
      expect(accounts.has(must), `thiếu TK ${must}`).toBe(true);
    }
  });

  it('BHTNLĐ-BNN 0.5% vào TK 3388', () => {
    const journals = buildGlJournalsFromAmounts([empA], CFG);
    const wci = journals
      .flatMap((j) => j.lines)
      .filter((l) => l.accountCode === '3388')
      .reduce((a, l) => a + (l.credit ?? 0), 0);
    expect(wci).toBe(empA.wciEmployer);
  });

  it('không sinh bút toán rỗng khi danh sách nhân viên rỗng', () => {
    expect(buildGlJournalsFromAmounts([], CFG)).toHaveLength(0);
  });

  it('ngày bút toán lấy từ cấu hình kỳ, không phải hôm nay', () => {
    const journals = buildGlJournalsFromAmounts([empA], CFG);
    for (const j of journals) expect(j.date).toBe('2026-03-31');
  });
});

describe('TK 334 phải tất toán khi kỳ lương đã chi hết', () => {
  it('dư 334 = 0 khi thực lĩnh + các khoản khấu trừ khớp gross', () => {
    const journals = buildGlJournalsFromAmounts([empA], CFG);
    const rec = reconcilePayableAccount(journals);
    expect(rec.account).toBe('334');
    expect(rec.settled).toBe(true);
    expect(rec.balance).toBe(0);
  });

  it('CÓ 334 đúng bằng tổng lương gross', () => {
    const journals = buildGlJournalsFromAmounts([empA, empB], CFG);
    const rec = reconcilePayroll334(journals);
    expect(rec.credit).toBe(empA.gross + empB.gross);
  });
});

/** Đọc riêng phần Có của TK 334 để kiểm tra tổng lương phải trả */
function reconcilePayroll334(journals: ReturnType<typeof buildGlJournalsFromAmounts>) {
  return reconcilePayableAccount(journals);
}
