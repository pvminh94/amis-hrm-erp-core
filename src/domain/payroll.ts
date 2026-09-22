/**
 * ============================================================================
 * PAYROLL ENGINE — ĐỘNG CƠ TÍNH LƯƠNG
 * ============================================================================
 *
 * Luồng tính cho MỘT nhân viên trong MỘT kỳ:
 *
 *   ┌─ 1. Chấm công tổng hợp ──────────────────────────────────────────┐
 *   │   ngày công, giờ đêm, giờ OT 150/200/300, số lần đi trễ...       │
 *   └──────────────────────────────┬───────────────────────────────────┘
 *                                  │
 *   ┌─ 2. Thu nhập ────────────────────────────────────────────────────┐
 *   │   lương cơ bản (tỷ lệ theo ngày công) + phụ cấp + KPI            │
 *   │   + hoa hồng (cầu nối Sales) + OT/đêm (Điều 98 BLLĐ 2019)        │
 *   └──────────────────────────────┬───────────────────────────────────┘
 *                                  │
 *   ┌─ 3. Phân loại chịu thuế / miễn thuế (TT 111/2013) ───────────────┐
 *   │   OT & phụ cấp đêm: miễn phần CHÊNH LỆCH cao hơn lương thường    │
 *   │   ăn trưa / xăng xe: miễn trong mức khoán, phần vượt chịu thuế    │
 *   └──────────────────────────────┬───────────────────────────────────┘
 *                                  │
 *   ┌─ 4. BHXH/BHYT/BHTN 10.5% & 21.5% (2 TRẦN KHÁC NHAU) ─────────────┐
 *   └──────────────────────────────┬───────────────────────────────────┘
 *                                  │
 *   ┌─ 5. Thuế TNCN luỹ tiến từng phần ────────────────────────────────┐
 *   └──────────────────────────────┬───────────────────────────────────┘
 *                                  │
 *   ┌─ 6. Thực lĩnh = Gross − 10.5% − TNCN − tạm ứng − khoản trừ khác ─┐
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Toàn bộ hàm THUẦN, không chạm DB => kiểm thử 100% được.
 */

import {
  buildPolicySnapshot,
  DEFAULT_INSURANCE_RATES,
  type InsuranceRates,
  type WageRegion,
} from '../config/insurance.js';
import { type TaxRegime, resolveTaxRegime } from '../config/tax-regime.js';
import { evalFormula, type FormulaContext } from './formula.js';
import { splitOvertimeTaxExemption, type OtTaxSplit } from './income-tax.js';
import { clamp, roundVnd } from './money.js';
import { computePersonalIncomeTax, type PitResult } from './pit.js';
import { computeInsurance, type InsuranceResult } from './social-insurance.js';

// ---------------------------------------------------------------------------
// ĐẦU VÀO
// ---------------------------------------------------------------------------

export interface AttendanceSummary {
  /** Số ngày công chuẩn thực tế (đã quy đổi, vd 24.5) */
  workedDays: number;
  /** Số ngày công theo kế hoạch (để tính tỷ lệ lương) */
  scheduledDays: number;
  /** Ngày nghỉ CÓ hưởng lương (nghỉ phép năm, lễ tết) */
  paidLeaveDays: number;
  /** Ngày nghỉ KHÔNG hưởng lương */
  unpaidLeaveDays: number;
  /** Giờ làm đêm trong ca chính => phụ cấp 30% */
  nightHours: number;
  otWeekdayHours: number;
  otWeekendHours: number;
  otHolidayHours: number;
  /** Số lần đi trễ (sau grace period) và tổng phút trễ */
  lateCount: number;
  lateMinutes: number;
  earlyLeaveCount: number;
  /** Số lần thiếu quẹt thẻ chưa giải trình */
  missingPunchCount: number;
  /** Ngày vắng không phép */
  absentDays: number;
}

export interface CustomComponent {
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION';
  /** Biểu thức động. Rỗng => dùng amount. */
  formula?: string | null;
  /** Số tiền cố định nếu không có formula */
  amount?: number;
  /** 'TAXABLE' | 'EXEMPT' | 'PARTIAL' */
  taxTreatment?: 'TAXABLE' | 'EXEMPT' | 'PARTIAL';
  /** Ngưỡng miễn thuế cho PARTIAL */
  exemptCap?: number;
  /** Có tính vào căn cứ đóng BHXH không */
  isSiBase?: boolean;
  note?: string;
}

export interface PayrollEmployeeInput {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  /** Mã TK Nợ chi phí nhân công theo phòng ban: 6421 / 6422 / 154 */
  costAccount: string;
  costCenterCode?: string;

  contract: {
    /** Lương cơ bản theo thang bảng lương */
    baseSalary: number;
    /** Lương ghi trên hợp đồng = căn cứ đóng BHXH/BHYT/BHTN */
    contractSalary: number;
    /** Lương KPI/hiệu quả tối đa (khi đạt 100% KPI) */
    maxKpiSalary?: number;
    /** Lương thử việc = baseSalary × probationRate */
    probationRate?: number;
    isProbation?: boolean;
  };

  insurance: {
    wageRegion: WageRegion;
    mandatory?: { si?: boolean; hi?: boolean; ui?: boolean };
    baseOverride?: number | null;
    applyFloorUplift?: boolean;
  };

  attendance: AttendanceSummary;

  /** Điểm KPI 0..100 */
  kpiScore?: number;
  /** Hoa hồng từ cầu nối Sales (đã tính sẵn) */
  commission?: number;
  /** Doanh thu để đưa vào biến công thức */
  commissionRevenue?: number;
  /** Số người phụ thuộc đủ điều kiện giảm trừ */
  dependents: number;
  /** Tạm ứng lương trong kỳ */
  advance?: number;
  /** Các khoản trừ khác (đoàn phí, bồi thường, vay công ty...) */
  otherDeductions?: Array<{ code: string; name: string; amount: number }>;
  /** Thành phần lương động do HR cấu hình */
  customComponents?: CustomComponent[];
  /** Giảm trừ khác có chứng từ */
  charityDonation?: number;
  voluntaryPension?: number;
}

export interface PayrollConfig {
  /** Ngày cuối kỳ lương — quyết định chế độ thuế & mức tham chiếu */
  periodEnd: Date | string;
  /** Chế độ thuế: 'AUTO' | 'LEGACY_7B' | 'BRIDGE_2026H1' | 'VN_2026_5B' */
  taxRegime?: string | TaxRegime | null;
  /** Số giờ/ngày và ngày/tháng chuẩn để tính lương giờ */
  standardWorkHours: number;
  standardWorkDays: number;
  /** Lương giờ tính trên LƯƠNG CƠ BẢN hay LƯƠNG HỢP ĐỒNG */
  hourlyRateBase: 'BASE' | 'CONTRACT';
  /** Tỷ lệ lương cho ngày nghỉ có hưởng lương (100%) */
  paidLeaveRate: number;
  /** Phụ cấp ăn trưa: số tiền/ngày và mức miễn thuế/tháng */
  mealPerDay: number;
  mealTaxExemptCap: number;
  /** Phụ cấp xăng xe/điện thoại khoán — mức miễn thuế/tháng */
  fuelTaxExemptCap: number;
  phoneTaxExemptCap: number;
  /** Quy tắc phạt */
  penalty: {
    /** Trừ bao nhiêu đồng mỗi lần đi trễ (sau grace) */
    latePerOccurrence: number;
    /** Trừ theo phút trễ: mỗi phút = hệ số × lương giờ (0 = không dùng) */
    latePerMinuteFactor: number;
    /** Số phút trễ cộng dồn thì bị trừ 1 công */
    lateMinutesPerDayCut: number;
    /** Hệ số trừ cho mỗi ngày vắng không phép (vd 2 = trừ 200% lương ngày) */
    absentDayFactor: number;
    /** Trừ mỗi lần về sớm */
    earlyLeavePerOccurrence: number;
    /** Trừ mỗi lần thiếu quẹt thẻ chưa giải trình */
    missingPunchPerOccurrence: number;
  };
  /** Hệ số OT (tối thiểu theo luật) */
  otRates: {
    weekday: number;
    weekend: number;
    holiday: number;
    night: number;
    /** Cộng thêm khi OT vào ban đêm */
    otNightExtra: number;
    /** Bù 20% khi OT ban đêm */
    otNightSupplement: number;
  };
  /**
   * Căn cứ đóng BHXH khi nhân viên nghỉ giữa kỳ:
   *  'FULL'     = dùng toàn bộ lương hợp đồng (thông lệ khi đi làm ≥ 14 ngày)
   *  'PRORATED' = tỷ lệ theo ngày công thực tế (khi nghỉ > 14 ngày không lương)
   *  'AUTO'     = nghỉ không lương > 14 ngày => PRORATED, ngược lại FULL
   */
  siBaseMode: 'FULL' | 'PRORATED' | 'AUTO';
  /** Ngưỡng ngày làm việc tối thiểu để đóng BHXH trong tháng */
  siMinWorkingDays: number;
  /** Có cho phép thực lĩnh âm không (nếu không, phần dư chuyển kỳ sau) */
  allowNegativeNet: boolean;
  rates?: InsuranceRates;
}

export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
  periodEnd: new Date().toISOString(),
  taxRegime: 'AUTO',
  standardWorkHours: 8,
  standardWorkDays: 26,
  hourlyRateBase: 'BASE',
  paidLeaveRate: 1,
  mealPerDay: 30_000,
  mealTaxExemptCap: 730_000,
  fuelTaxExemptCap: 0,
  phoneTaxExemptCap: 0,
  penalty: {
    latePerOccurrence: 0,
    latePerMinuteFactor: 0.5,
    lateMinutesPerDayCut: 120,
    absentDayFactor: 1,
    earlyLeavePerOccurrence: 0,
    missingPunchPerOccurrence: 0,
  },
  otRates: {
    weekday: 1.5,
    weekend: 2,
    holiday: 3,
    night: 0.3,
    otNightExtra: 0.3,
    otNightSupplement: 0.2,
  },
  siBaseMode: 'AUTO',
  siMinWorkingDays: 14,
  allowNegativeNet: false,
  rates: DEFAULT_INSURANCE_RATES,
};

// ---------------------------------------------------------------------------
// ĐẦU RA
// ---------------------------------------------------------------------------

export interface PayrollLineItem {
  code: string;
  name: string;
  amount: number;
  taxableAmount: number;
  exemptAmount: number;
  taxTreatment: 'TAXABLE' | 'EXEMPT' | 'PARTIAL';
  /** Ngưỡng miễn thuế đã áp dụng (cho khoản PARTIAL) — dùng để giải trình */
  exemptCap?: number;
  formulaUsed?: string;
  note?: string;
}

export interface PayrollResult {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  periodEnd: string;
  taxRegimeCode: string;
  taxRegimeName: string;

  hourlyRate: number;
  /** Tỷ lệ lương áp dụng theo ngày công (0..1+) */
  prorateRatio: number;

  earnings: PayrollLineItem[];
  gross: number;

  otDetail: OtTaxSplit | null;

  /** Thu nhập chịu thuế sau khi loại các khoản miễn thuế */
  assessableIncome: number;
  taxExemptTotal: number;

  siBase: number;
  uiBase: number;
  insurance: InsuranceResult;
  totalInsuranceEmployee: number;
  totalInsuranceEmployer: number;

  pit: PitResult;
  pitAmount: number;

  deductionItems: PayrollLineItem[];
  totalDeductions: number;
  advance: number;

  net: number;
  /** Phần thực lĩnh bị âm chuyển sang kỳ sau (nếu không cho phép net âm) */
  carryForward: number;
  /** Tổng chi phí doanh nghiệp = gross + 21.5% */
  totalCostToCompany: number;

  warnings: string[];
  /** Snapshot công thức đã dùng — phục vụ audit & tái lập */
  audit: {
    formulaContext: Record<string, number>;
    customComponentsApplied: string[];
    siBaseModeResolved: string;
  };
}

// ---------------------------------------------------------------------------
// HÀM CHÍNH
// ---------------------------------------------------------------------------

/** Kết quả bảo hiểm rỗng — dùng khi không phát sinh đóng trong tháng */
function zeroInsurance(
  _base: number,
  cfg: PayrollConfig,
  wageRegion: WageRegion,
): InsuranceResult {
  const snap = buildPolicySnapshot(cfg.periodEnd, cfg.rates);
  return {
    siBase: 0,
    uiBase: 0,
    siCapApplied: snap.siCap,
    uiCapApplied: snap.uiCapByRegion[wageRegion],
    referenceSalary: snap.referenceSalary,
    minWage: snap.minWage[wageRegion],
    siCapHit: false,
    uiCapHit: false,
    floorApplied: false,
    employee: { si: 0, hi: 0, ui: 0, total: 0 },
    employer: { si: 0, hi: 0, ui: 0, wci: 0, total: 0 },
    totalEmployerCost: 0,
    totalCostToCompany: 0,
    notes: [],
  };
}

export function calculatePayroll(
  input: PayrollEmployeeInput,
  config: Partial<PayrollConfig> = {},
): PayrollResult {
  const cfg: PayrollConfig = {
    ...DEFAULT_PAYROLL_CONFIG,
    ...config,
    penalty: { ...DEFAULT_PAYROLL_CONFIG.penalty, ...(config.penalty ?? {}) },
    otRates: { ...DEFAULT_PAYROLL_CONFIG.otRates, ...(config.otRates ?? {}) },
  };
  const warnings: string[] = [];

  // ---- 0. Tham số hợp đồng -------------------------------------------------
  const baseSalaryRaw = roundVnd(input.contract.baseSalary);
  const contractSalary = roundVnd(input.contract.contractSalary);
  if (baseSalaryRaw <= 0) throw new Error(`[${input.employeeCode}] Lương cơ bản phải > 0`);
  if (contractSalary <= 0) throw new Error(`[${input.employeeCode}] Lương hợp đồng phải > 0`);

  const isProbation = input.contract.isProbation === true;
  const probationRate = input.contract.probationRate ?? 0.85;
  const probationFactor = isProbation ? probationRate : 1;
  const baseSalary = roundVnd(baseSalaryRaw * probationFactor);
  if (isProbation) {
    warnings.push(
      `Lương thử việc: ${baseSalary.toLocaleString('vi-VN')}đ = ${baseSalaryRaw.toLocaleString('vi-VN')}đ × ${(probationRate * 100).toFixed(0)}% (Điều 26 BLLĐ 2019: tối thiểu 85%)`,
    );
    if (probationRate < 0.85) {
      warnings.push('CẢNH BÁO PHÁP LÝ: tỷ lệ lương thử việc < 85% — vi phạm Điều 26 BLLĐ 2019');
    }
  }

  // ---- 1. Tỷ lệ lương theo ngày công ---------------------------------------
  const a = input.attendance;
  const scheduledDays = Math.max(0, a.scheduledDays);
  const workedDays = Math.max(0, a.workedDays);
  const paidLeaveDays = Math.max(0, a.paidLeaveDays);
  const unpaidLeaveDays = Math.max(0, a.unpaidLeaveDays);

  // Ngày công được hưởng lương = ngày làm thực tế + ngày nghỉ có lương
  const paidDays = workedDays + paidLeaveDays;
  let prorateRatio = 1;
  if (scheduledDays > 0) {
    prorateRatio = clamp(paidDays / scheduledDays, 0, 1);
  }
  if (unpaidLeaveDays > 0) {
    warnings.push(`Có ${unpaidLeaveDays} ngày nghỉ không hưởng lương — đã trừ khỏi ngày công`);
  }

  // ---- 2. Lương giờ ---------------------------------------------------------
  const hourlyRateBaseAmount = cfg.hourlyRateBase === 'CONTRACT' ? contractSalary : baseSalary;
  const hourlyRate = roundVnd(hourlyRateBaseAmount / cfg.standardWorkDays / cfg.standardWorkHours);

  // ---- 3. Biến số cho công thức động ---------------------------------------
  const formulaContext: FormulaContext = {
    baseSalary,
    baseSalaryRaw,
    contractSalary,
    hourlyRate,
    prorateRatio,
    workedDays,
    paidDays,
    scheduledDays,
    unpaidLeaveDays,
    paidLeaveDays,
    nightHours: a.nightHours,
    otWeekdayHours: a.otWeekdayHours,
    otWeekendHours: a.otWeekendHours,
    otHolidayHours: a.otHolidayHours,
    kpiScore: input.kpiScore ?? 0,
    maxKpiSalary: roundVnd(input.contract.maxKpiSalary ?? 0),
    commissionRevenue: roundVnd(input.commissionRevenue ?? 0),
    commission: roundVnd(input.commission ?? 0),
    mealPerDay: cfg.mealPerDay,
    standardWorkHours: cfg.standardWorkHours,
    standardWorkDays: cfg.standardWorkDays,
    lateMinutes: a.lateMinutes,
    lateCount: a.lateCount,
    absentDays: a.absentDays,
  };

  // ---- 4. Các khoản THU NHẬP ------------------------------------------------
  const earnings: PayrollLineItem[] = [];
  const addEarning = (item: PayrollLineItem) => {
    if (item.amount !== 0) earnings.push(item);
  };

  // 4.1 Lương cơ bản (tỷ lệ theo ngày công)
  const baseProRated = roundVnd(baseSalary * prorateRatio);
  addEarning({
    code: 'BASE',
    name: 'Lương cơ bản',
    amount: baseProRated,
    taxableAmount: baseProRated,
    exemptAmount: 0,
    taxTreatment: 'TAXABLE',
    note: prorateRatio < 1
      ? `Tỷ lệ ${paidDays}/${scheduledDays} ngày công = ${(prorateRatio * 100).toFixed(2)}%`
      : undefined,
  });

  // 4.2 Lương KPI
  const kpiScore = clamp(input.kpiScore ?? 0, 0, 100);
  const maxKpi = roundVnd(input.contract.maxKpiSalary ?? 0);
  if (maxKpi > 0 && kpiScore > 0) {
    const kpiAmount = roundVnd(maxKpi * (kpiScore / 100) * prorateRatio);
    addEarning({
      code: 'KPI',
      name: 'Lương hiệu quả KPI',
      amount: kpiAmount,
      taxableAmount: kpiAmount,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
      formulaUsed: `maxKpiSalary * kpiScore / 100 * prorateRatio`,
      note: `KPI ${kpiScore}%`,
    });
  }

  // 4.3 Phụ cấp ăn trưa (PARTIAL — miễn trong mức khoán)
  const mealAmount = roundVnd(cfg.mealPerDay * paidDays);
  if (mealAmount > 0) {
    const exempt = Math.min(mealAmount, cfg.mealTaxExemptCap);
    addEarning({
      code: 'MEAL',
      name: 'Phụ cấp ăn trưa',
      amount: mealAmount,
      taxableAmount: mealAmount - exempt,
      exemptAmount: exempt,
      taxTreatment: 'PARTIAL',
      exemptCap: cfg.mealTaxExemptCap,
      note: `${cfg.mealPerDay.toLocaleString('vi-VN')}đ/ngày × ${paidDays} ngày; miễn thuế tối đa ${cfg.mealTaxExemptCap.toLocaleString('vi-VN')}đ/tháng`,
    });
  }

  // 4.4 Hoa hồng từ cầu nối Sales
  const commission = roundVnd(input.commission ?? 0);
  if (commission !== 0) {
    addEarning({
      code: 'COMMISSION',
      name: 'Hoa hồng kinh doanh',
      amount: commission,
      taxableAmount: commission,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
      note: 'Từ cầu nối Sales → Payroll',
    });
  }

  // 4.5 Thành phần động do HR cấu hình
  const appliedCustom: string[] = [];
  const customEarnings: PayrollLineItem[] = [];
  const customDeductions: PayrollLineItem[] = [];
  let customSiBaseAdd = 0;

  for (const comp of input.customComponents ?? []) {
    let amount: number;
    if (comp.formula && comp.formula.trim() !== '') {
      amount = roundVnd(evalFormula(comp.formula, formulaContext));
    } else {
      amount = roundVnd(comp.amount ?? 0);
    }
    if (amount === 0) continue;
    appliedCustom.push(`${comp.code}=${amount}`);

    const treatment = comp.taxTreatment ?? 'TAXABLE';
    let taxable = amount;
    let exempt = 0;
    if (treatment === 'EXEMPT') {
      taxable = 0;
      exempt = amount;
    } else if (treatment === 'PARTIAL') {
      exempt = Math.min(amount, comp.exemptCap ?? 0);
      taxable = amount - exempt;
    }
    const line: PayrollLineItem = {
      code: comp.code,
      name: comp.name,
      amount,
      taxableAmount: taxable,
      exemptAmount: exempt,
      taxTreatment: treatment,
      formulaUsed: comp.formula ?? undefined,
      note: comp.note,
    };
    if (comp.type === 'EARNING') customEarnings.push(line);
    else customDeductions.push(line);
    if (comp.isSiBase) customSiBaseAdd += amount;
  }
  earnings.push(...customEarnings);

  // ---- 5. Làm thêm giờ & phụ cấp đêm (Điều 98 BLLĐ 2019) -------------------
  const otRates = cfg.otRates;
  const otWeekdayAmount = roundVnd(hourlyRate * otRates.weekday * a.otWeekdayHours);
  const otWeekendAmount = roundVnd(hourlyRate * otRates.weekend * a.otWeekendHours);
  const otHolidayAmount = roundVnd(hourlyRate * otRates.holiday * a.otHolidayHours);

  // Phần cộng thêm cho giờ LÀM ĐÊM trong ca chính (30%)
  const nightAllowanceAmount = roundVnd(hourlyRate * otRates.night * a.nightHours);

  if (otWeekdayAmount > 0) {
    addEarning({
      code: 'OT_WEEKDAY',
      name: 'Lương làm thêm giờ ngày thường (150%)',
      amount: otWeekdayAmount,
      // Phần bằng lương ngày thường (100%) vẫn chịu thuế; phần vượt (50%) miễn
      taxableAmount: roundVnd(hourlyRate * 1 * a.otWeekdayHours),
      exemptAmount: roundVnd(hourlyRate * (otRates.weekday - 1) * a.otWeekdayHours),
      taxTreatment: 'PARTIAL',
      note: `${a.otWeekdayHours}h × ${hourlyRate.toLocaleString('vi-VN')}đ × ${otRates.weekday * 100}%`,
    });
  }
  if (otWeekendAmount > 0) {
    addEarning({
      code: 'OT_WEEKEND',
      name: 'Lương làm thêm giờ ngày nghỉ hằng tuần (200%)',
      amount: otWeekendAmount,
      taxableAmount: roundVnd(hourlyRate * 1 * a.otWeekendHours),
      exemptAmount: roundVnd(hourlyRate * (otRates.weekend - 1) * a.otWeekendHours),
      taxTreatment: 'PARTIAL',
      note: `${a.otWeekendHours}h × ${hourlyRate.toLocaleString('vi-VN')}đ × ${otRates.weekend * 100}%`,
    });
  }
  if (otHolidayAmount > 0) {
    addEarning({
      code: 'OT_HOLIDAY',
      name: 'Lương làm thêm giờ ngày lễ, tết (300%)',
      amount: otHolidayAmount,
      taxableAmount: roundVnd(hourlyRate * 1 * a.otHolidayHours),
      exemptAmount: roundVnd(hourlyRate * (otRates.holiday - 1) * a.otHolidayHours),
      taxTreatment: 'PARTIAL',
      note: `${a.otHolidayHours}h × ${hourlyRate.toLocaleString('vi-VN')}đ × ${otRates.holiday * 100}%`,
    });
  }
  if (nightAllowanceAmount > 0) {
    addEarning({
      code: 'NIGHT_ALLOWANCE',
      name: 'Phụ cấp làm đêm 30% (Điều 98 khoản 2 BLLĐ 2019)',
      amount: nightAllowanceAmount,
      taxableAmount: 0,
      exemptAmount: nightAllowanceAmount,
      taxTreatment: 'EXEMPT',
      note: `${a.nightHours}h × ${hourlyRate.toLocaleString('vi-VN')}đ × 30% — miễn thuế theo điểm i khoản 1 Điều 3 TT 111/2013`,
    });
  }

  // Kiểm tra chéo bằng hàm tách miễn thuế độc lập
  const otDetail = splitOvertimeTaxExemption({
    normalHourlyRate: hourlyRate,
    otWeekdayHours: a.otWeekdayHours,
    otWeekendHours: a.otWeekendHours,
    otHolidayHours: a.otHolidayHours,
    nightHours: a.nightHours,
    rates: otRates,
  });
  const otPaidInline = otWeekdayAmount + otWeekendAmount + otHolidayAmount + nightAllowanceAmount;
  if (Math.abs(otPaidInline - otDetail.totalPaid) > 3) {
    warnings.push(
      `Chênh lệch OT/đêm giữa engine (${otPaidInline.toLocaleString('vi-VN')}đ) và bộ tách miễn thuế (${otDetail.totalPaid.toLocaleString('vi-VN')}đ) — kiểm tra cấu hình hệ số`,
    );
  }

  const gross = roundVnd(earnings.reduce((acc, e) => acc + e.amount, 0));
  const taxExemptTotal = roundVnd(earnings.reduce((acc, e) => acc + e.exemptAmount, 0));
  const assessableIncome = roundVnd(earnings.reduce((acc, e) => acc + e.taxableAmount, 0));

  // ---- 6. Bảo hiểm bắt buộc -------------------------------------------------
  const totalUnpaid = unpaidLeaveDays;
  let siBaseModeResolved = cfg.siBaseMode;
  if (siBaseModeResolved === 'AUTO') {
    siBaseModeResolved = totalUnpaid > cfg.siMinWorkingDays - 0 ? 'PRORATED' : 'FULL';
    // Chính xác hơn: không đóng BHXH tháng nghỉ không lương >= 14 ngày
    siBaseModeResolved = totalUnpaid >= 14 ? 'PRORATED' : 'FULL';
  }
  const siContractBase =
    siBaseModeResolved === 'PRORATED'
      ? roundVnd(contractSalary * prorateRatio)
      : roundVnd(contractSalary * probationFactor) + customSiBaseAdd;

  // Khoản 4 Điều 42 Quyết định 595/QĐ-BHXH: NLĐ nghỉ việc hưởng chế độ
  // ốm đau từ 14 ngày làm việc trở lên trong tháng thì KHÔNG đóng BHXH,
  // BHYT, BHTN, BHTNLĐ-BNN của tháng đó. Áp dụng tương tự cho nghỉ không lương.
  const exemptFromInsurance = siBaseModeResolved === 'PRORATED' && totalUnpaid >= 14;
  if (exemptFromInsurance) {
    warnings.push(
      `Nghỉ không lương ${totalUnpaid} ngày (≥ 14 ngày) — KHÔNG phát sinh đóng BHXH/BHYT/BHTN tháng này ` +
        `(khoản 4 Điều 42 Quyết định 595/QĐ-BHXH)`,
    );
  } else if (siBaseModeResolved === 'PRORATED') {
    warnings.push(
      `Căn cứ đóng BHXH/BHYT/BHTN tính theo tỷ lệ ngày công: ${siContractBase.toLocaleString('vi-VN')}đ`,
    );
  }

  const insurance =
    exemptFromInsurance || siContractBase <= 0
      ? zeroInsurance(siContractBase, cfg, input.insurance.wageRegion)
      : computeInsurance(
          {
            contractSalary: siContractBase,
            wageRegion: input.insurance.wageRegion,
            asOf: cfg.periodEnd,
            mandatory: input.insurance.mandatory,
            baseOverride: input.insurance.baseOverride,
            applyFloorUplift: input.insurance.applyFloorUplift,
            rates: cfg.rates,
          },
          gross,
        );
  warnings.push(...insurance.notes.map((n) => `[BHXH] ${n}`));

  // ---- 7. Thuế TNCN ---------------------------------------------------------
  const pit = computePersonalIncomeTax({
    assessableIncome,
    mandatoryInsurance: insurance.employee.total,
    dependents: input.dependents,
    regime: cfg.taxRegime as string | TaxRegime | null,
    periodEnd: cfg.periodEnd,
    charityDonation: input.charityDonation,
    voluntaryPension: input.voluntaryPension,
  });
  warnings.push(...pit.notes.map((n) => `[TNCN] ${n}`));
  if (!pit.quickFormulaMatch) {
    warnings.push('[TNCN] Công thức luỹ tiến từng phần và công thức rút gọn lệch nhau');
  }

  // ---- 8. Các khoản TRỪ ------------------------------------------------------
  const deductionItems: PayrollLineItem[] = [];
  const addDeduction = (item: PayrollLineItem) => {
    if (item.amount !== 0) deductionItems.push(item);
  };
  const p = cfg.penalty;

  // 8.1 Phạt đi trễ
  let latePenalty = 0;
  if (p.latePerMinuteFactor > 0 && a.lateMinutes > 0) {
    latePenalty += roundVnd(hourlyRate * p.latePerMinuteFactor * (a.lateMinutes / 60));
  }
  if (p.latePerOccurrence > 0 && a.lateCount > 0) {
    latePenalty += p.latePerOccurrence * a.lateCount;
  }
  if (p.lateMinutesPerDayCut > 0 && a.lateMinutes >= p.lateMinutesPerDayCut) {
    const dayCut = Math.floor(a.lateMinutes / p.lateMinutesPerDayCut);
    const daySalary = roundVnd(baseSalary / Math.max(1, cfg.standardWorkDays));
    latePenalty += dayCut * daySalary;
    warnings.push(`Trễ ${a.lateMinutes}' ≥ ${p.lateMinutesPerDayCut}' → trừ ${dayCut} ngày công`);
  }
  if (latePenalty > 0) {
    addDeduction({
      code: 'PENALTY_LATE',
      name: 'Trừ đi trễ',
      amount: roundVnd(latePenalty),
      taxableAmount: 0,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
      note: `${a.lateCount} lần, tổng ${a.lateMinutes} phút`,
    });
  }

  // 8.2 Phạt về sớm / thiếu quẹt
  if (p.earlyLeavePerOccurrence > 0 && a.earlyLeaveCount > 0) {
    addDeduction({
      code: 'PENALTY_EARLY',
      name: 'Trừ về sớm',
      amount: p.earlyLeavePerOccurrence * a.earlyLeaveCount,
      taxableAmount: 0,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
    });
  }
  if (p.missingPunchPerOccurrence > 0 && a.missingPunchCount > 0) {
    addDeduction({
      code: 'PENALTY_MISSING_PUNCH',
      name: 'Trừ thiếu quẹt thẻ chưa giải trình',
      amount: p.missingPunchPerOccurrence * a.missingPunchCount,
      taxableAmount: 0,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
    });
  }

  // 8.3 Vắng không phép
  if (a.absentDays > 0 && p.absentDayFactor > 0) {
    const daySalary = roundVnd(baseSalary / Math.max(1, cfg.standardWorkDays));
    const absentPenalty = roundVnd(daySalary * p.absentDayFactor * a.absentDays);
    addDeduction({
      code: 'PENALTY_ABSENT',
      name: 'Trừ ngày vắng không phép',
      amount: absentPenalty,
      taxableAmount: 0,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
      note: `${a.absentDays} ngày × hệ số ${p.absentDayFactor}`,
    });
  }

  // 8.4 Các khoản trừ động
  deductionItems.push(...customDeductions);

  // 8.5 Tạm ứng & khoản khác
  const advance = roundVnd(input.advance ?? 0);
  if (advance > 0) {
    addDeduction({
      code: 'ADVANCE',
      name: 'Tạm ứng lương',
      amount: advance,
      taxableAmount: 0,
      exemptAmount: 0,
      taxTreatment: 'TAXABLE',
    });
  }
  for (const d of input.otherDeductions ?? []) {
    const amt = roundVnd(d.amount);
    if (amt !== 0) {
      addDeduction({
        code: d.code,
        name: d.name,
        amount: amt,
        taxableAmount: 0,
        exemptAmount: 0,
        taxTreatment: 'TAXABLE',
      });
    }
  }

  const totalDeductions = roundVnd(deductionItems.reduce((acc, d) => acc + d.amount, 0));

  // ---- 9. Thực lĩnh ----------------------------------------------------------
  let net = roundVnd(gross - insurance.employee.total - pit.tax - totalDeductions);
  let carryForward = 0;
  if (net < 0) {
    if (!cfg.allowNegativeNet) {
      carryForward = -net;
      net = 0;
      warnings.push(
        `Thực lĩnh âm — chuyển ${carryForward.toLocaleString('vi-VN')}đ sang kỳ sau khấu trừ tiếp`,
      );
    } else {
      warnings.push('Thực nhận âm — kiểm tra tạm ứng/khoản trừ');
    }
  }

  const totalCostToCompany = roundVnd(gross + insurance.employer.total);

  return {
    employeeId: input.employeeId,
    employeeCode: input.employeeCode,
    fullName: input.fullName,
    periodEnd: new Date(cfg.periodEnd).toISOString().slice(0, 10),
    taxRegimeCode: pit.regimeCode,
    taxRegimeName: pit.regimeName,
    hourlyRate,
    prorateRatio,
    earnings,
    gross,
    otDetail,
    assessableIncome,
    taxExemptTotal,
    siBase: insurance.siBase,
    uiBase: insurance.uiBase,
    insurance,
    totalInsuranceEmployee: insurance.employee.total,
    totalInsuranceEmployer: insurance.employer.total,
    pit,
    pitAmount: pit.tax,
    deductionItems,
    totalDeductions,
    advance,
    net,
    carryForward,
    totalCostToCompany,
    warnings,
    audit: {
      formulaContext: Object.fromEntries(
        Object.entries(formulaContext).map(([k, v]) => [k, Number(v ?? 0)]),
      ),
      customComponentsApplied: appliedCustom,
      siBaseModeResolved,
    },
  };
}

/**
 * Tính lương cho cả bảng (hàng loạt). Đây là hàm được BullMQ worker
 * CALC_PROGRESSIVE_TAX gọi theo lô để không chặn event loop.
 */
export function calculatePayrollBatch(
  employees: readonly PayrollEmployeeInput[],
  config: Partial<PayrollConfig> = {},
): { results: PayrollResult[]; errors: Array<{ employeeCode: string; error: string }> } {
  const results: PayrollResult[] = [];
  const errors: Array<{ employeeCode: string; error: string }> = [];
  for (const emp of employees) {
    try {
      results.push(calculatePayroll(emp, config));
    } catch (e) {
      errors.push({
        employeeCode: emp.employeeCode,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { results, errors };
}
