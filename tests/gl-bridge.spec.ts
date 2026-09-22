/**
 * Kiểm thử CẦU NỐI KẾ TOÁN (double-entry) và FILE THANH TOÁN NGÂN HÀNG.
 */
import { describe, expect, it } from 'vitest';

import {
  assertBalanced,
  buildPayrollJournalSummary,
  buildPayrollJournalsForEmployee,
  DEFAULT_CHART_OF_ACCOUNTS as A,
  JournalError,
  reconcilePayableAccount,
  validateJournal,
} from '../src/domain/gl-bridge.js';
import {
  generateInsuranceDeclarationCsv,
  generatePaymentFile,
  PaymentFileError,
  removeVietnameseTones,
  validatePaymentFile,
  type PaymentFileInfo,
} from '../src/domain/payment-file.js';

const emp = {
  employeeId: 'aaaa1111-2222-3333-4444-555566667777',
  departmentCode: 'KD',
  costCenterCode: 'CC-KD',
  gross: 30_000_000,
  siEmployee: 2_400_000,
  hiEmployee: 450_000,
  uiEmployee: 300_000,
  pit: 1_000_000,
  siEmployer: 5_100_000,
  hiEmployer: 900_000,
  uiEmployer: 300_000,
  wciEmployer: 150_000,
  net: 25_850_000,
};

describe('validateJournal — ràng buộc kế toán kép', () => {
  it('bút toán cân Nợ = Có', () => {
    const v = validateJournal({
      entryNo: 'JV-1',
      date: '2026-09-30',
      description: 'test',
      sourceType: 'PAYROLL',
      lines: [
        { accountCode: '6422', debit: 1000, credit: 0 },
        { accountCode: '334', debit: 0, credit: 1000 },
      ],
    });
    expect(v.balanced).toBe(true);
    expect(v.totalDebit).toBe(1000);
    expect(v.totalCredit).toBe(1000);
  });

  it('LỆCH Nợ/Có → assertBalanced ném lỗi', () => {
    expect(() =>
      assertBalanced({
        entryNo: 'JV-2',
        date: '2026-09-30',
        description: 'test',
        sourceType: 'PAYROLL',
        lines: [
          { accountCode: '6422', debit: 1000, credit: 0 },
          { accountCode: '334', debit: 0, credit: 900 },
        ],
      }),
    ).toThrow(JournalError);
  });

  it('một dòng vừa Nợ vừa Có → lỗi', () => {
    const v = validateJournal({
      entryNo: 'JV-3',
      date: '2026-09-30',
      description: 't',
      sourceType: 'PAYROLL',
      lines: [
        { accountCode: '6422', debit: 100, credit: 100 },
        { accountCode: '334', debit: 0, credit: 100 },
        { accountCode: '1121', debit: 100, credit: 0 },
      ],
    });
    expect(v.invalidLines).toEqual([0]);
  });

  it('số tiền âm → lỗi', () => {
    expect(() =>
      validateJournal({
        entryNo: 'JV-4',
        date: '2026-09-30',
        description: 't',
        sourceType: 'PAYROLL',
        lines: [
          { accountCode: '6422', debit: -100, credit: 0 },
          { accountCode: '334', debit: 0, credit: -100 },
        ],
      }),
    ).toThrow(/số tiền âm/);
  });

  it('bút toán rỗng / 1 dòng → lỗi', () => {
    expect(() =>
      validateJournal({ entryNo: 'E', date: '2026-09-30', description: '', sourceType: 'MANUAL', lines: [] }),
    ).toThrow(/không có dòng/);
    expect(() =>
      validateJournal({
        entryNo: 'E',
        date: '2026-09-30',
        description: '',
        sourceType: 'MANUAL',
        lines: [{ accountCode: '334', debit: 100, credit: 0 }],
      }),
    ).toThrow(/kế toán kép/);
  });
});

describe('buildPayrollJournalsForEmployee — bút toán lương 1 nhân viên', () => {
  const cfg = {
    date: '2026-09-30',
    payRunId: 'pr-1',
    periodLabel: 'Kỳ lương 09/2026',
    costAccountByDepartment: { KD: A.SELLING_EXPENSE, HC: A.ADMIN_EXPENSE, SX: A.WIP_PRODUCTION },
  };

  it('sinh đủ 5 bút toán và tất cả đều cân đối', () => {
    const entries = buildPayrollJournalsForEmployee(emp, cfg);
    expect(entries).toHaveLength(5);
    for (const e of entries) {
      const v = validateJournal(e);
      expect(v.balanced, `${e.entryNo} phải cân`).toBe(true);
    }
  });

  it('bút toán 1: Nợ 6421 (phòng KD = chi phí bán hàng) / Có 334', () => {
    const [e1] = buildPayrollJournalsForEmployee(emp, cfg);
    expect(e1!.lines[0]!.accountCode).toBe('6421');
    expect(e1!.lines[0]!.debit).toBe(30_000_000);
    expect(e1!.lines[1]!.accountCode).toBe('334');
    expect(e1!.lines[1]!.credit).toBe(30_000_000);
  });

  it('bút toán 2: Nợ 334 / Có 3383 + 3384 + 3386 đúng 10.5%', () => {
    const entries = buildPayrollJournalsForEmployee(emp, cfg);
    const e = entries[1]!;
    expect(e.lines[0]!.accountCode).toBe('334');
    expect(e.lines[0]!.debit).toBe(3_150_000);
    const credits = e.lines.slice(1);
    expect(credits.map((l) => l.accountCode)).toEqual(['3383', '3384', '3386']);
    expect(credits.map((l) => l.credit)).toEqual([2_400_000, 450_000, 300_000]);
  });

  it('bút toán 3: Nợ 334 / Có 3335 (thuế TNCN)', () => {
    const entries = buildPayrollJournalsForEmployee(emp, cfg);
    const e = entries[2]!;
    expect(e.lines[0]!.accountCode).toBe('334');
    expect(e.lines[0]!.debit).toBe(1_000_000);
    expect(e.lines[1]!.accountCode).toBe('3335');
    expect(e.lines[1]!.credit).toBe(1_000_000);
  });

  it('bút toán 4: Nợ 6421 / Có 3383+3384+3386+3388 đúng 21.5%', () => {
    const entries = buildPayrollJournalsForEmployee(emp, cfg);
    const e = entries[3]!;
    expect(e.lines[0]!.accountCode).toBe('6421');
    expect(e.lines[0]!.debit).toBe(6_450_000);
    const credits = e.lines.slice(1);
    expect(credits.map((l) => l.accountCode)).toEqual(['3383', '3384', '3386', '3388']);
    expect(credits.reduce((a, b) => a + (b.credit ?? 0), 0)).toBe(6_450_000);
  });

  it('bút toán 5: Nợ 334 / Có 1121 (thực lĩnh qua ngân hàng)', () => {
    const entries = buildPayrollJournalsForEmployee(emp, cfg);
    const e = entries[4]!;
    expect(e.lines[0]!.accountCode).toBe('334');
    expect(e.lines[0]!.debit).toBe(25_850_000);
    expect(e.lines[1]!.accountCode).toBe('1121');
    expect(e.lines[1]!.credit).toBe(25_850_000);
  });

  it('khoản trừ khác sinh bút toán Nợ 334 / Có 141 (tạm ứng)', () => {
    const entries = buildPayrollJournalsForEmployee(
      {
        ...emp,
        gross: 30_000_000,
        net: 20_850_000,
        otherDeductions: [{ code: 'ADVANCE', amount: 5_000_000 }],
      },
      cfg,
    );
    expect(entries).toHaveLength(6);
    const adv = entries[4]!;
    expect(adv.lines[0]!.accountCode).toBe('334');
    expect(adv.lines[1]!.accountCode).toBe('141');
    expect(adv.lines[1]!.credit).toBe(5_000_000);
  });

  it('BẤT BIẾN: gross ≠ tổng phân bổ → ném lỗi, không sinh bút toán sai', () => {
    expect(() =>
      buildPayrollJournalsForEmployee({ ...emp, net: 99_999_999 }, cfg),
    ).toThrow(JournalError);
  });

  it('phòng ban khác nhau → TK chi phí khác nhau', () => {
    const hc = buildPayrollJournalsForEmployee({ ...emp, departmentCode: 'HC' }, cfg);
    expect(hc[0]!.lines[0]!.accountCode).toBe('6422');
    const sx = buildPayrollJournalsForEmployee({ ...emp, departmentCode: 'SX' }, cfg);
    expect(sx[0]!.lines[0]!.accountCode).toBe('154');
  });

  it('employerInsurancePosting = VIA_334 → Nợ 334 thay vì TK chi phí', () => {
    const entries = buildPayrollJournalsForEmployee(emp, {
      ...cfg,
      employerInsurancePosting: 'VIA_334',
    });
    expect(entries[3]!.lines[0]!.accountCode).toBe('334');
  });

  it('không có thuế / không có bảo hiểm → bỏ qua bút toán tương ứng', () => {
    const entries = buildPayrollJournalsForEmployee(
      {
        ...emp,
        pit: 0,
        siEmployee: 0,
        hiEmployee: 0,
        uiEmployee: 0,
        siEmployer: 0,
        hiEmployer: 0,
        uiEmployer: 0,
        wciEmployer: 0,
        net: 30_000_000,
      },
      cfg,
    );
    expect(entries).toHaveLength(2); // chi phí lương + chi tiền
  });
});

describe('buildPayrollJournalSummary — bút toán tổng hợp cả bảng', () => {
  const cfg = {
    date: '2026-09-30',
    payRunId: 'pr-1',
    periodLabel: 'Kỳ lương 09/2026',
    costAccountByDepartment: { KD: A.SELLING_EXPENSE, HC: A.ADMIN_EXPENSE },
  };

  const emp2 = {
    ...emp,
    employeeId: 'bbbb1111-2222-3333-4444-555566667777',
    departmentCode: 'HC',
    gross: 20_000_000,
    siEmployee: 1_600_000,
    hiEmployee: 300_000,
    uiEmployee: 200_000,
    pit: 200_000,
    siEmployer: 3_400_000,
    hiEmployer: 600_000,
    uiEmployer: 200_000,
    wciEmployer: 100_000,
    net: 17_700_000,
  };

  it('bút toán tổng hợp cân đối tuyệt đối', () => {
    const { summary, details, perEmployee } = buildPayrollJournalSummary([emp, emp2], cfg);
    const v = validateJournal(summary);
    expect(v.balanced).toBe(true);
    expect(details.length).toBe(perEmployee[0]!.length + perEmployee[1]!.length);
    // Tổng Nợ = 30tr + 20tr (chi phí lương) + 3.15 + 1 + 6.45 + 0.2 + 17.7 + ...
    expect(v.totalDebit).toBe(v.totalCredit);
  });

  it('gom đúng 2 TK chi phí theo 2 phòng ban', () => {
    const { summary } = buildPayrollJournalSummary([emp, emp2], cfg);
    const costLines = summary.lines.filter((l) => (l.debit ?? 0) > 0 && ['6421', '6422'].includes(l.accountCode));
    expect(costLines).toHaveLength(4); // 2 cho lương + 2 cho bảo hiểm NSDLĐ
    const selling = costLines.filter((l) => l.accountCode === '6421');
    expect(selling.reduce((a, b) => a + (b.debit ?? 0), 0)).toBe(30_000_000 + 6_450_000);
  });

  it('đối chiếu TK 334 cuối kỳ = 0 (đã chi hết)', () => {
    const { summary } = buildPayrollJournalSummary([emp, emp2], cfg);
    const r = reconcilePayableAccount([summary]);
    expect(r.settled).toBe(true);
    expect(r.balance).toBe(0);
  });

  it('đối chiếu phát hiện chưa chi hết', () => {
    const entries = buildPayrollJournalsForEmployee(emp, cfg);
    const withoutPayment = entries.slice(0, -1); // bỏ bút toán chi tiền
    const r = reconcilePayableAccount(withoutPayment);
    expect(r.settled).toBe(false);
    expect(r.balance).toBe(25_850_000);
  });
});

// ===========================================================================
// FILE THANH TOÁN NGÂN HÀNG
// ===========================================================================

function paymentInfo(over: Partial<PaymentFileInfo> = {}): PaymentFileInfo {
  return {
    batchNo: 'B20260901',
    date: '2026-09-30',
    payer: {
      name: 'CÔNG TY CP CÔNG NGHỆ AMIS',
      accountNumber: '0071001234567',
      bankCode: 'VCBVNVX',
      branch: 'CN TP.HCM',
      taxCode: '0312345678',
    },
    bank: 'VCB',
    purpose: 'SALARY',
    periodLabel: '09/2026',
    rows: [
      {
        employeeId: 'e1',
        employeeCode: 'NV001',
        fullName: 'Trần Minh Tuấn',
        accountNumber: '0071009876543',
        beneficiaryName: 'TRẦN MINH TUẤN',
        beneficiaryBankCode: 'VCBVNVX',
        amount: 25_850_000,
        description: 'Luong T09/2026 NV001',
      },
      {
        employeeId: 'e2',
        employeeCode: 'NV002',
        fullName: 'Lê Thị Hương',
        accountNumber: '1903456789012',
        beneficiaryName: 'LÊ THỊ HƯƠNG',
        beneficiaryBankCode: 'TCBKVNVX',
        amount: 17_700_000,
        description: 'Luong T09/2026 NV002',
      },
    ],
    ...over,
  };
}

describe('validatePaymentFile', () => {
  it('dữ liệu hợp lệ', () => {
    const v = validatePaymentFile(paymentInfo());
    expect(v.ok).toBe(true);
    expect(v.rowCount).toBe(2);
    expect(v.totalAmount).toBe(43_550_000);
  });

  it('STK có chữ → lỗi', () => {
    const info = paymentInfo();
    info.rows[0]!.accountNumber = '00710O9876543';
    const v = validatePaymentFile(info);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('chỉ gồm chữ số'))).toBe(true);
  });

  it('STK quá ngắn theo quy định từng ngân hàng', () => {
    const info = paymentInfo({ bank: 'CTG' });
    info.rows[0]!.accountNumber = '12345';
    const v = validatePaymentFile(info);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('tối thiểu 9 của CTG'))).toBe(true);
  });

  it('số tiền <= 0 → lỗi', () => {
    const info = paymentInfo();
    info.rows[0]!.amount = 0;
    expect(validatePaymentFile(info).ok).toBe(false);
  });

  it('trùng STK + số tiền → cảnh báo', () => {
    const info = paymentInfo();
    info.rows[1] = { ...info.rows[0]!, employeeCode: 'NV003' };
    const v = validatePaymentFile(info);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('trùng'))).toBe(true);
  });

  it('rỗng → lỗi', () => {
    expect(validatePaymentFile(paymentInfo({ rows: [] })).ok).toBe(false);
  });
});

describe('generatePaymentFile — 4 ngân hàng', () => {
  it('VCB: fixed-width, HEADER/DETAIL/FOOTER, tổng ở footer khớp', () => {
    const f = generatePaymentFile(paymentInfo({ bank: 'VCB' }));
    expect(f.format).toBe('txt');
    expect(f.fileName).toMatch(/^UNC_VCB_SALARY_20260930_B20260901\.txt$/);
    const lines = f.content.trim().split('\r\n');
    expect(lines[0]!.startsWith('A|')).toBe(true);
    expect(lines[1]!.startsWith('D|00001|')).toBe(true);
    expect(lines[3]!.startsWith('Z|')).toBe(true);
    expect(lines[3]).toContain('43550000');
    // Không còn dấu tiếng Việt trong file VCB
    expect(f.content).not.toMatch(/[àáảãạâăđèéêìíòóôơùúưỳý]/i);
    expect(f.checksum).toHaveLength(64);
  });

  it('TCB / CTG / MBB: CSV có tiêu đề và dòng tổng', () => {
    for (const bank of ['TCB', 'CTG', 'MBB'] as const) {
      const f = generatePaymentFile(paymentInfo({ bank }));
      expect(f.format).toBe('csv');
      expect(f.content.startsWith('\uFEFF')).toBe(true); // BOM cho Excel
      expect(f.content).toContain('Tên người thụ hưởng');
      expect(f.content).toContain('TỔNG CỘNG');
      expect(f.totalAmount).toBe(43_550_000);
      expect(f.rowCount).toBe(2);
    }
  });

  it('ném lỗi thay vì sinh file sai', () => {
    const info = paymentInfo();
    info.rows[0]!.amount = -5;
    expect(() => generatePaymentFile(info)).toThrow(PaymentFileError);
  });

  it('checksum ổn định với cùng nội dung', () => {
    const a = generatePaymentFile(paymentInfo());
    const b = generatePaymentFile(paymentInfo());
    expect(a.checksum).toBe(b.checksum);
  });

  it('CSV escape dấu phẩy và dấu nháy trong nội dung', () => {
    const info = paymentInfo({ bank: 'TCB' });
    info.rows[0]!.description = 'Luong "T09", thang 9';
    const f = generatePaymentFile(info);
    expect(f.content).toContain('"Luong ""T09"", thang 9"');
  });
});

describe('removeVietnameseTones', () => {
  it('bỏ dấu và viết hoa', () => {
    expect(removeVietnameseTones('Trần Minh Tuấn')).toBe('TRAN MINH TUAN');
    expect(removeVietnameseTones('Nguyễn Thị Hồng Đào')).toBe('NGUYEN THI HONG DAO');
    expect(removeVietnameseTones('Đặng Văn Ếch')).toBe('DANG VAN ECH');
  });
});

describe('generateInsuranceDeclarationCsv — bảng kê nộp BHXH', () => {
  it('có dòng tổng và tổng khớp', () => {
    const f = generateInsuranceDeclarationCsv('TN01234', '09/2026', [
      {
        employeeCode: 'NV001',
        fullName: 'Trần Minh Tuấn',
        siNumber: '0791234567',
        siBase: 30_000_000,
        uiBase: 30_000_000,
        siEmployee: 2_400_000,
        hiEmployee: 450_000,
        uiEmployee: 300_000,
        siEmployer: 5_100_000,
        hiEmployer: 900_000,
        uiEmployer: 300_000,
        wciEmployer: 150_000,
      },
    ]);
    expect(f.rowCount).toBe(1);
    // 10.5% (NLĐ) + 21.5% (NSDLĐ) = 32% × 30.000.000 = 9.600.000
    expect(f.totalAmount).toBe(9_600_000);
    expect(f.content).toContain('TN01234');
    expect(f.content.trim().endsWith('9600000')).toBe(true);
  });
});
