/**
 * ============================================================================
 * CẦU NỐI NHÂN SỰ → KẾ TOÁN (HR to GENERAL LEDGER BRIDGE)
 * ============================================================================
 *
 * Khi bảng lương được duyệt chi trả, hệ thống tự động sinh bút toán kép
 * (double-entry) theo Thông tư 200/2014/TT-BTC:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ 1. Ghi nhận chi phí nhân công theo phòng ban                         │
 *   │    NỢ   6421 / 6422 / 154   (chi phí bán hàng / QLDN / SXKD dở dang) │
 *   │    CÓ   334                 Phải trả người lao động                  │
 *   │                                                                      │
 *   │ 2. Trích trừ BHXH/BHYT/BHTN phần NLĐ chịu (10.5%)                    │
 *   │    NỢ   334                                                          │
 *   │    CÓ   3383 (BHXH 8%), 3384 (BHYT 1.5%), 3386 (BHTN 1%)             │
 *   │                                                                      │
 *   │ 3. Trích trừ thuế TNCN                                               │
 *   │    NỢ   334                                                          │
 *   │    CÓ   3335                 Thuế TNCN phải nộp                      │
 *   │                                                                      │
 *   │ 4. Chi phí bảo hiểm NSDLĐ gánh chịu (21.5%) — tính vào chi phí DN     │
 *   │    NỢ   6421/6422/154 (hoặc 334 nếu DN chọn ghi qua phải trả)         │
 *   │    CÓ   3383 (17%), 3384 (3%), 3386 (1%), 3388 (BHTNLĐ-BNN 0.5%)     │
 *   │                                                                      │
 *   │ 5. Chi trả thực lĩnh qua ngân hàng                                   │
 *   │    NỢ   334                                                          │
 *   │    CÓ   1121                 Tiền gửi ngân hàng (VND)                │
 *   │                                                                      │
 *   │ 6. Khoản trừ khác (tạm ứng, đoàn phí, bồi thường...)                  │
 *   │    NỢ   334                                                          │
 *   │    CÓ   141 / 3382 / 1388 ...                                        │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * RÀNG BUỘC BẤT BIẾN: Σ NỢ = Σ CÓ trên từng bút toán. Hàm `validateJournal`
 * kiểm tra điều này và NÉM LỖI nếu lệch — không bao giờ ghi sổ lệch.
 */

import { roundVnd } from './money.js';

export type AccountSide = 'DEBIT' | 'CREDIT';

export interface JournalLineInput {
  accountCode: string;
  subAccount?: string;
  debit?: number;
  credit?: number;
  costCenterCode?: string;
  employeeId?: string;
  memo?: string;
}

export interface JournalEntryInput {
  entryNo: string;
  date: string; // YYYY-MM-DD
  description: string;
  sourceType: 'PAYROLL' | 'MANUAL' | 'SALES';
  sourceId?: string;
  lines: JournalLineInput[];
}

export interface ValidatedJournal {
  entry: JournalEntryInput;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  /** Số dòng có cả NỢ và CÓ (không hợp lệ) */
  invalidLines: number[];
}

export class JournalError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

/** Hệ thống tài khoản mặc định theo Thông tư 200/2014/TT-BTC */
export const DEFAULT_CHART_OF_ACCOUNTS = {
  // Tài sản
  CASH_VND: '1111',
  BANK_VND: '1121',
  ADVANCE: '141',
  OTHER_RECEIVABLE: '1388',
  WIP_PRODUCTION: '154',
  // Nợ phải trả
  PAYABLE_EMPLOYEE: '334',
  SI_PAYABLE: '3383', // BHXH
  HI_PAYABLE: '3384', // BHYT
  UI_PAYABLE: '3386', // BHTN
  WCI_PAYABLE: '3388', // BHTNLĐ-BNN (một số DN dùng 3389)
  UNION_FEE_PAYABLE: '3382', // Kinh phí công đoàn
  PIT_PAYABLE: '3335', // Thuế TNCN
  // Chi phí
  SELLING_EXPENSE: '6421', // Chi phí bán hàng
  ADMIN_EXPENSE: '6422', // Chi phí QLDN
} as const;

/**
 * Kiểm tra tính cân đối của bút toán kép.
 * NÉM LỖI nếu lệch NỢ/CÓ — đây là ràng buộc cứng của kế toán kép.
 */
export function validateJournal(entry: JournalEntryInput, tolerance = 0): ValidatedJournal {
  if (!entry.lines || entry.lines.length === 0) {
    throw new JournalError('EMPTY_JOURNAL', `Bút toán ${entry.entryNo} không có dòng nào`);
  }
  if (entry.lines.length < 2) {
    throw new JournalError(
      'SINGLE_SIDED',
      `Bút toán ${entry.entryNo} chỉ có 1 dòng — kế toán kép cần tối thiểu 2 dòng`,
    );
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const invalidLines: number[] = [];

  entry.lines.forEach((line, idx) => {
    const d = roundVnd(line.debit ?? 0);
    const c = roundVnd(line.credit ?? 0);
    if (d !== 0 && c !== 0) invalidLines.push(idx);
    if (d < 0 || c < 0) {
      throw new JournalError(
        'NEGATIVE_AMOUNT',
        `Dòng ${idx} của ${entry.entryNo} có số tiền âm (Nợ ${d}, Có ${c})`,
      );
    }
    totalDebit += d;
    totalCredit += c;
  });

  const balanced = Math.abs(totalDebit - totalCredit) <= tolerance;
  return { entry, totalDebit, totalCredit, balanced, invalidLines };
}

/** Assert cân đối — dùng trước khi ghi DB */
export function assertBalanced(entry: JournalEntryInput): ValidatedJournal {
  const v = validateJournal(entry);
  if (v.invalidLines.length > 0) {
    throw new JournalError(
      'LINE_BOTH_SIDES',
      `Bút toán ${entry.entryNo} có dòng vừa Nợ vừa Có tại chỉ số ${v.invalidLines.join(', ')}`,
    );
  }
  if (!v.balanced) {
    throw new JournalError(
      'UNBALANCED',
      `Bút toán ${entry.entryNo} LỆCH: Nợ ${v.totalDebit.toLocaleString('vi-VN')} ≠ Có ${v.totalCredit.toLocaleString('vi-VN')} (chênh ${Math.abs(
        v.totalDebit - v.totalCredit,
      ).toLocaleString('vi-VN')}đ)`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// SINH BÚT TOÁN LƯƠNG
// ---------------------------------------------------------------------------

export interface GlPayrollInput {
  /** Số bút toán gốc (các dòng con sẽ đánh số entryNo-01, -02...) */
  entryNoPrefix: string;
  date: string;
  payRunId: string;
  periodLabel: string; // vd "Kỳ lương 09/2026"
  /**
   * Cách hạch toán phần 21.5% NSDLĐ chịu:
   *  'EXPENSE' = Nợ thẳng 6421/6422/154 (khuyến nghị, đúng bản chất chi phí)
   *  'VIA_334' = Nợ 334 rồi Có 338 — dùng khi DN muốn gom qua tài khoản phải trả
   */
  employerInsurancePosting: 'EXPENSE' | 'VIA_334';
  /** TK chi trả: 1121 tiền gửi ngân hàng, 1111 tiền mặt */
  paymentAccount: string;
  /** Ánh xạ mã phòng ban → TK chi phí */
  costAccountByDepartment: Record<string, string>;
  defaultCostAccount: string;
  /** TK cho các khoản trừ khác, theo mã khoản trừ */
  deductionAccountMap: Record<string, string>;
}

export interface GlEmployeeAmounts {
  employeeId: string;
  departmentCode: string;
  costCenterCode?: string;
  /** Tổng lương phải trả (gross) */
  gross: number;
  siEmployee: number;
  hiEmployee: number;
  uiEmployee: number;
  pit: number;
  /** Phần NSDLĐ chịu */
  siEmployer: number;
  hiEmployer: number;
  uiEmployer: number;
  wciEmployer: number;
  /** Thực lĩnh chuyển khoản */
  net: number;
  /** Các khoản trừ khác: { code, account?, amount } */
  otherDeductions?: Array<{ code: string; amount: number; accountCode?: string }>;
}

export const DEFAULT_GL_CONFIG: GlPayrollInput = {
  entryNoPrefix: 'JV',
  date: new Date().toISOString().slice(0, 10),
  payRunId: '',
  periodLabel: '',
  employerInsurancePosting: 'EXPENSE',
  paymentAccount: DEFAULT_CHART_OF_ACCOUNTS.BANK_VND,
  costAccountByDepartment: {},
  defaultCostAccount: DEFAULT_CHART_OF_ACCOUNTS.ADMIN_EXPENSE,
  deductionAccountMap: {
    ADVANCE: DEFAULT_CHART_OF_ACCOUNTS.ADVANCE,
    UNION_FEE: DEFAULT_CHART_OF_ACCOUNTS.UNION_FEE_PAYABLE,
    COMPENSATION: DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE,
    PENALTY_LATE: DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE,
    PENALTY_ABSENT: DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE,
    PENALTY_EARLY: DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE,
    PENALTY_MISSING_PUNCH: DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE,
  },
};

function costAccountFor(deptCode: string, cfg: GlPayrollInput): string {
  return cfg.costAccountByDepartment[deptCode] ?? cfg.defaultCostAccount;
}

/**
 * Sinh bộ bút toán cho MỘT nhân viên trong kỳ lương.
 * Trả về mảng JournalEntryInput đã được kiểm tra cân đối.
 */
export function buildPayrollJournalsForEmployee(
  emp: GlEmployeeAmounts,
  cfg: Partial<GlPayrollInput> = {},
): JournalEntryInput[] {
  const c: GlPayrollInput = {
    ...DEFAULT_GL_CONFIG,
    ...cfg,
    costAccountByDepartment: { ...DEFAULT_GL_CONFIG.costAccountByDepartment, ...(cfg.costAccountByDepartment ?? {}) },
    deductionAccountMap: { ...DEFAULT_GL_CONFIG.deductionAccountMap, ...(cfg.deductionAccountMap ?? {}) },
  };

  const costAcc = costAccountFor(emp.departmentCode, c);
  const gross = roundVnd(emp.gross);
  const siE = roundVnd(emp.siEmployee);
  const hiE = roundVnd(emp.hiEmployee);
  const uiE = roundVnd(emp.uiEmployee);
  const pit = roundVnd(emp.pit);
  const siEm = roundVnd(emp.siEmployer);
  const hiEm = roundVnd(emp.hiEmployer);
  const uiEm = roundVnd(emp.uiEmployer);
  const wciEm = roundVnd(emp.wciEmployer);
  const net = roundVnd(emp.net);

  const entries: JournalEntryInput[] = [];
  let seq = 0;
  const nextNo = () => `${c.entryNoPrefix}-${emp.employeeId.slice(0, 8).toUpperCase()}-${String(++seq).padStart(2, '0')}`;

  const otherDeductions = (emp.otherDeductions ?? [])
    .map((d) => ({ ...d, amount: roundVnd(d.amount) }))
    .filter((d) => d.amount !== 0);
  const totalOtherDeductions = otherDeductions.reduce((a, b) => a + b.amount, 0);

  // --- Kiểm tra bất biến số học TRƯỚC khi sinh dòng -------------------------
  // gross = BHXH NLĐ + TNCN + khoản trừ khác + thực lĩnh (+ phần chuyển kỳ sau)
  const sum = siE + hiE + uiE + pit + totalOtherDeductions + net;
  if (sum !== gross) {
    throw new JournalError(
      'PAYROLL_IDENTITY_VIOLATION',
      `Nhân viên ${emp.employeeId}: gross ${gross.toLocaleString('vi-VN')} ≠ tổng phân bổ ${sum.toLocaleString(
        'vi-VN',
      )} (BHXH ${siE + hiE + uiE} + TNCN ${pit} + trừ khác ${totalOtherDeductions} + thực lĩnh ${net})`,
    );
  }

  // --- 1. Ghi nhận chi phí nhân công ---------------------------------------
  if (gross > 0) {
    entries.push({
      entryNo: nextNo(),
      date: c.date,
      description: `${c.periodLabel} — Chi phí lương phải trả`,
      sourceType: 'PAYROLL',
      sourceId: c.payRunId,
      lines: [
        {
          accountCode: costAcc,
          debit: gross,
          credit: 0,
          costCenterCode: emp.costCenterCode ?? emp.departmentCode,
          employeeId: emp.employeeId,
          memo: 'Chi phí nhân công',
        },
        {
          accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE,
          debit: 0,
          credit: gross,
          employeeId: emp.employeeId,
          memo: 'Phải trả người lao động',
        },
      ],
    });
  }

  // --- 2. Trích trừ BHXH/BHYT/BHTN phần NLĐ (10.5%) -------------------------
  const empInsuranceTotal = siE + hiE + uiE;
  if (empInsuranceTotal > 0) {
    const lines: JournalLineInput[] = [
      {
        accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE,
        debit: empInsuranceTotal,
        credit: 0,
        employeeId: emp.employeeId,
        memo: 'Trích trừ BHXH/BHYT/BHTN NLĐ',
      },
    ];
    if (siE > 0) {
      lines.push({
        accountCode: DEFAULT_CHART_OF_ACCOUNTS.SI_PAYABLE,
        subAccount: '33831',
        debit: 0,
        credit: siE,
        memo: 'BHXH 8% (hưu trí, tử tuất)',
      });
    }
    if (hiE > 0) {
      lines.push({
        accountCode: DEFAULT_CHART_OF_ACCOUNTS.HI_PAYABLE,
        debit: 0,
        credit: hiE,
        memo: 'BHYT 1.5%',
      });
    }
    if (uiE > 0) {
      lines.push({
        accountCode: DEFAULT_CHART_OF_ACCOUNTS.UI_PAYABLE,
        debit: 0,
        credit: uiE,
        memo: 'BHTN 1%',
      });
    }
    entries.push({
      entryNo: nextNo(),
      date: c.date,
      description: `${c.periodLabel} — Trích trừ bảo hiểm NLĐ 10.5%`,
      sourceType: 'PAYROLL',
      sourceId: c.payRunId,
      lines,
    });
  }

  // --- 3. Trích trừ thuế TNCN ----------------------------------------------
  if (pit > 0) {
    entries.push({
      entryNo: nextNo(),
      date: c.date,
      description: `${c.periodLabel} — Khấu trừ thuế TNCN`,
      sourceType: 'PAYROLL',
      sourceId: c.payRunId,
      lines: [
        {
          accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE,
          debit: pit,
          credit: 0,
          employeeId: emp.employeeId,
          memo: 'Khấu trừ thuế TNCN tại nguồn',
        },
        {
          accountCode: DEFAULT_CHART_OF_ACCOUNTS.PIT_PAYABLE,
          debit: 0,
          credit: pit,
          memo: 'Thuế TNCN phải nộp NSNN',
        },
      ],
    });
  }

  // --- 4. Chi phí bảo hiểm NSDLĐ gánh chịu (21.5%) --------------------------
  const emTotal = siEm + hiEm + uiEm + wciEm;
  if (emTotal > 0) {
    const debitAccount = c.employerInsurancePosting === 'EXPENSE'
      ? costAcc
      : DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE;
    const lines: JournalLineInput[] = [
      {
        accountCode: debitAccount,
        debit: emTotal,
        credit: 0,
        costCenterCode: c.employerInsurancePosting === 'EXPENSE' ? (emp.costCenterCode ?? emp.departmentCode) : undefined,
        employeeId: c.employerInsurancePosting === 'EXPENSE' ? emp.employeeId : undefined,
        memo: 'Chi phí BHXH/BHYT/BHTN/BHTNLĐ NSDLĐ chịu 21.5%',
      },
    ];
    if (siEm > 0) {
      lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.SI_PAYABLE, subAccount: '33832', debit: 0, credit: siEm, memo: 'BHXH 17% NSDLĐ' });
    }
    if (hiEm > 0) {
      lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.HI_PAYABLE, debit: 0, credit: hiEm, memo: 'BHYT 3% NSDLĐ' });
    }
    if (uiEm > 0) {
      lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.UI_PAYABLE, debit: 0, credit: uiEm, memo: 'BHTN 1% NSDLĐ' });
    }
    if (wciEm > 0) {
      lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.WCI_PAYABLE, debit: 0, credit: wciEm, memo: 'BHTNLĐ-BNN 0.5% NSDLĐ' });
    }
    entries.push({
      entryNo: nextNo(),
      date: c.date,
      description: `${c.periodLabel} — Trích bảo hiểm NSDLĐ chịu 21.5%`,
      sourceType: 'PAYROLL',
      sourceId: c.payRunId,
      lines,
    });
  }

  // --- 5. Các khoản trừ khác -------------------------------------------------
  for (const d of otherDeductions) {
    const acc = d.accountCode ?? c.deductionAccountMap[d.code] ?? DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE;
    entries.push({
      entryNo: nextNo(),
      date: c.date,
      description: `${c.periodLabel} — Khoản trừ ${d.code}`,
      sourceType: 'PAYROLL',
      sourceId: c.payRunId,
      lines: [
        {
          accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE,
          debit: d.amount,
          credit: 0,
          employeeId: emp.employeeId,
          memo: `Trừ ${d.code}`,
        },
        { accountCode: acc, debit: 0, credit: d.amount, memo: `Khoản trừ ${d.code}` },
      ],
    });
  }

  // --- 6. Chi trả thực lĩnh qua ngân hàng ------------------------------------
  if (net > 0) {
    entries.push({
      entryNo: nextNo(),
      date: c.date,
      description: `${c.periodLabel} — Chi trả lương qua ngân hàng`,
      sourceType: 'PAYROLL',
      sourceId: c.payRunId,
      lines: [
        {
          accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE,
          debit: net,
          credit: 0,
          employeeId: emp.employeeId,
          memo: 'Chi lương thực lĩnh',
        },
        {
          accountCode: c.paymentAccount,
          debit: 0,
          credit: net,
          memo: 'Tiền gửi ngân hàng VND',
        },
      ],
    });
  }

  // --- Kiểm tra cân đối toàn bộ ---------------------------------------------
  for (const e of entries) assertBalanced(e);
  return entries;
}

/**
 * Sinh bút toán cho CẢ BẢNG LƯƠNG — gom theo phòng ban để giảm số dòng.
 * Trả về một bút toán tổng hợp (tổng Nợ các TK chi phí = tổng Có 334...)
 * kèm các bút toán chi tiết nếu `includeDetails`.
 */
export function buildPayrollJournalSummary(
  employees: readonly GlEmployeeAmounts[],
  cfg: Partial<GlPayrollInput> = {},
): { summary: JournalEntryInput; details: JournalEntryInput[]; perEmployee: JournalEntryInput[][] } {
  const c: GlPayrollInput = { ...DEFAULT_GL_CONFIG, ...cfg };

  const detailEntries: JournalEntryInput[] = [];
  const perEmployee: JournalEntryInput[][] = [];

  // Gom theo (TK chi phí, loại bút toán)
  const grossByCostAccount = new Map<string, number>();
  const employerInsByCostAccount = new Map<string, number>();
  let siE = 0, hiE = 0, uiE = 0, pit = 0, siEm = 0, hiEm = 0, uiEm = 0, wciEm = 0, net = 0;
  const otherByAccount = new Map<string, number>();

  for (const emp of employees) {
    const entries = buildPayrollJournalsForEmployee(emp, c);
    perEmployee.push(entries);
    detailEntries.push(...entries);

    const costAcc = costAccountFor(emp.departmentCode, c);
    const gross = roundVnd(emp.gross);
    grossByCostAccount.set(costAcc, (grossByCostAccount.get(costAcc) ?? 0) + gross);

    const emTotal = roundVnd(emp.siEmployer + emp.hiEmployer + emp.uiEmployer + emp.wciEmployer);
    if (c.employerInsurancePosting === 'EXPENSE') {
      employerInsByCostAccount.set(costAcc, (employerInsByCostAccount.get(costAcc) ?? 0) + emTotal);
    }

    siE += roundVnd(emp.siEmployee);
    hiE += roundVnd(emp.hiEmployee);
    uiE += roundVnd(emp.uiEmployee);
    pit += roundVnd(emp.pit);
    siEm += roundVnd(emp.siEmployer);
    hiEm += roundVnd(emp.hiEmployer);
    uiEm += roundVnd(emp.uiEmployer);
    wciEm += roundVnd(emp.wciEmployer);
    net += roundVnd(emp.net);

    for (const d of emp.otherDeductions ?? []) {
      const amt = roundVnd(d.amount);
      if (amt === 0) continue;
      const acc = d.accountCode ?? c.deductionAccountMap[d.code] ?? DEFAULT_CHART_OF_ACCOUNTS.OTHER_RECEIVABLE;
      otherByAccount.set(acc, (otherByAccount.get(acc) ?? 0) + amt);
    }
  }

  // Dựng bút toán tổng hợp
  const lines: JournalLineInput[] = [];

  // Nợ chi phí / Có 334
  let totalGross = 0;
  for (const [acc, amt] of grossByCostAccount) {
    if (amt === 0) continue;
    lines.push({ accountCode: acc, debit: amt, credit: 0, memo: 'Chi phí lương theo bộ phận' });
    totalGross += amt;
  }
  if (totalGross > 0) {
    lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE, debit: 0, credit: totalGross, memo: 'Tổng phải trả NLĐ' });
  }

  // Nợ 334 / Có 338x (NLĐ)
  const empIns = siE + hiE + uiE;
  if (empIns > 0) {
    lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE, debit: empIns, credit: 0, memo: 'Trích bảo hiểm NLĐ 10.5%' });
    if (siE > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.SI_PAYABLE, subAccount: '33831', debit: 0, credit: siE, memo: 'BHXH NLĐ' });
    if (hiE > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.HI_PAYABLE, debit: 0, credit: hiE, memo: 'BHYT NLĐ' });
    if (uiE > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.UI_PAYABLE, debit: 0, credit: uiE, memo: 'BHTN NLĐ' });
  }

  // Nợ 334 / Có 3335
  if (pit > 0) {
    lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE, debit: pit, credit: 0, memo: 'Khấu trừ thuế TNCN' });
    lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PIT_PAYABLE, debit: 0, credit: pit, memo: 'Thuế TNCN phải nộp' });
  }

  // Chi phí NSDLĐ 21.5%
  const emTotal = siEm + hiEm + uiEm + wciEm;
  if (emTotal > 0) {
    if (c.employerInsurancePosting === 'EXPENSE') {
      for (const [acc, amt] of employerInsByCostAccount) {
        if (amt === 0) continue;
        lines.push({ accountCode: acc, debit: amt, credit: 0, memo: 'Chi phí bảo hiểm NSDLĐ 21.5%' });
      }
    } else {
      lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE, debit: emTotal, credit: 0, memo: 'Bảo hiểm NSDLĐ qua 334' });
    }
    if (siEm > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.SI_PAYABLE, subAccount: '33832', debit: 0, credit: siEm, memo: 'BHXH NSDLĐ 17%' });
    if (hiEm > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.HI_PAYABLE, debit: 0, credit: hiEm, memo: 'BHYT NSDLĐ 3%' });
    if (uiEm > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.UI_PAYABLE, debit: 0, credit: uiEm, memo: 'BHTN NSDLĐ 1%' });
    if (wciEm > 0) lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.WCI_PAYABLE, debit: 0, credit: wciEm, memo: 'BHTNLĐ-BNN 0.5%' });
  }

  // Khoản trừ khác
  for (const [acc, amt] of otherByAccount) {
    lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE, debit: amt, credit: 0, memo: 'Khoản trừ khác' });
    lines.push({ accountCode: acc, debit: 0, credit: amt, memo: 'Khoản trừ khác' });
  }

  // Chi trả qua ngân hàng
  if (net > 0) {
    lines.push({ accountCode: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE, debit: net, credit: 0, memo: 'Chi lương' });
    lines.push({ accountCode: c.paymentAccount, debit: 0, credit: net, memo: 'Tiền gửi ngân hàng' });
  }

  const summary: JournalEntryInput = {
    entryNo: `${c.entryNoPrefix}-SUMMARY`,
    date: c.date,
    description: `${c.periodLabel} — Bút toán lương tổng hợp (${employees.length} nhân viên)`,
    sourceType: 'PAYROLL',
    sourceId: c.payRunId,
    lines,
  };

  assertBalanced(summary);
  return { summary, details: detailEntries, perEmployee };
}

/** Đối chiếu số dư TK 334 cuối kỳ — phải bằng 0 nếu đã chi trả hết */
export function reconcilePayableAccount(journals: readonly JournalEntryInput[]): {
  account: string;
  debit: number;
  credit: number;
  balance: number;
  settled: boolean;
} {
  let debit = 0;
  let credit = 0;
  for (const j of journals) {
    for (const l of j.lines) {
      if (l.accountCode === DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE) {
        debit += roundVnd(l.debit ?? 0);
        credit += roundVnd(l.credit ?? 0);
      }
    }
  }
  const balance = credit - debit; // 334 là tài khoản nợ phải trả, dư Có
  return {
    account: DEFAULT_CHART_OF_ACCOUNTS.PAYABLE_EMPLOYEE,
    debit,
    credit,
    balance,
    settled: balance === 0,
  };
}
