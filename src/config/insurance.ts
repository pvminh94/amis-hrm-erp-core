/**
 * ============================================================================
 * THAM SỐ BHXH / BHYT / BHTN — CÓ PHIÊN BẢN THEO NGÀY HIỆU LỰC
 * ============================================================================
 *
 * Tỷ lệ trích nộp (ổn định qua các năm, không đổi ở 2026):
 *   NLĐ đóng 10.5%  = BHXH 8% + BHYT 1.5% + BHTN 1%
 *   NSDLĐ đóng 21.5% = BHXH 17% + BHYT 3% + BHTN 1% + BHTNLĐ-BNN 0.5%
 *
 * Trần (mức lương làm căn cứ đóng tối đa):
 *   BHXH & BHYT: 20 lần MỨC THAM CHIẾU.
 *     Khoản 13 Điều 141 Luật BHXH 2024: khi chưa bãi bỏ mức lương cơ sở thì
 *     mức tham chiếu = mức lương cơ sở.
 *       - Trước 01/07/2026: 2.340.000 đ  => trần 46.800.000 đ (NĐ 73/2024)
 *       - Từ  01/07/2026: 2.530.000 đ  => trần 50.600.000 đ (NĐ 161/2026)
 *     (Đề bài ghi "20 lần mức lương cơ sở" — vẫn đúng về bản chất, nhưng từ
 *      01/07/2025 Luật BHXH 2024 dùng khái niệm "mức tham chiếu".)
 *
 *   BHTN: 20 lần MỨC LƯƠNG TỐI THIỂU THÁNG THEO VÙNG
 *     (Điều 34 Luật Việc làm 2025, hiệu lực 01/01/2026 — thống nhất cho mọi
 *      nhóm đối tượng, không còn phân biệt khối nhà nước/doanh nghiệp).
 *     NĐ 293/2025/NĐ-CP, từ 01/01/2026:
 *       Vùng I  5.310.000 đ => trần BHTN 106.200.000 đ
 *       Vùng II 4.730.000 đ => trần BHTN  94.600.000 đ
 *       Vùng III 4.140.000 đ => trần BHTN  82.800.000 đ
 *       Vùng IV 3.700.000 đ => trần BHTN  74.000.000 đ
 *
 * Sàn: tiền lương làm căn cứ đóng BHXH thấp nhất = mức tham chiếu
 *      (điểm đ khoản 1 Điều 31 Luật BHXH 2024).
 *
 * NGUỒN TRA CỨU (đã kiểm chứng khi viết file này):
 *   - Luật Bảo hiểm xã hội 2024 (Điều 31, Điều 33, khoản 13 Điều 141)
 *   - Nghị định 73/2024/NĐ-CP (mức lương cơ sở 2.340.000 đ từ 01/07/2024)
 *   - Nghị định 161/2026/NĐ-CP (mức lương cơ sở 2.530.000 đ từ 01/07/2026)
 *   - Luật Việc làm 2025 (Điều 34), Nghị định 293/2025/NĐ-CP (LTTV 2026)
 * ============================================================================
 */

export type WageRegion = 'I' | 'II' | 'III' | 'IV';

/** Tỷ lệ trích nộp — không đổi theo thời kỳ, nhưng vẫn để cấu hình được */
export interface InsuranceRates {
  /** NLĐ */
  employee: {
    si: number; // 8%   BHXH (hưu trí 5% + ốm đau thai sản... gộp theo QĐ 595)
    hi: number; // 1.5% BHYT
    ui: number; // 1%   BHTN
  };
  /** NSDLĐ — hạch toán vào chi phí doanh nghiệp */
  employer: {
    si: number;  // 17%  BHXH
    hi: number;  // 3%   BHYT
    ui: number;  // 1%   BHTN
    wci: number; // 0.5% BHTNLĐ-BNN
  };
}

export const DEFAULT_INSURANCE_RATES: InsuranceRates = {
  employee: { si: 0.08, hi: 0.015, ui: 0.01 },
  employer: { si: 0.17, hi: 0.03, ui: 0.01, wci: 0.005 },
};

export const EMPLOYEE_TOTAL_RATE =
  DEFAULT_INSURANCE_RATES.employee.si +
  DEFAULT_INSURANCE_RATES.employee.hi +
  DEFAULT_INSURANCE_RATES.employee.ui; // 0.105 = 10.5%

export const EMPLOYER_TOTAL_RATE =
  DEFAULT_INSURANCE_RATES.employer.si +
  DEFAULT_INSURANCE_RATES.employer.hi +
  DEFAULT_INSURANCE_RATES.employer.ui +
  DEFAULT_INSURANCE_RATES.employer.wci; // 0.215 = 21.5%

/** Hệ số nhân trần */
export const SI_CAP_MULTIPLIER = 20; // 20 lần mức tham chiếu
export const UI_CAP_MULTIPLIER = 20; // 20 lần mức lương tối thiểu vùng

/** Mức tham chiếu (= mức lương cơ sở khi chưa bãi bỏ) theo thời kỳ */
export interface ReferenceSalaryPeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
  amount: number;
  basis: string;
}

export const REFERENCE_SALARY_PERIODS: readonly ReferenceSalaryPeriod[] = [
  {
    effectiveFrom: '2024-07-01',
    effectiveTo: '2026-06-30',
    amount: 2_340_000,
    basis: 'Nghị định 73/2024/NĐ-CP',
  },
  {
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    amount: 2_530_000,
    basis: 'Nghị định 161/2026/NĐ-CP',
  },
];

/** Mức lương tối thiểu tháng theo vùng, theo thời kỳ */
export interface MinWagePeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
  basis: string;
  regions: Record<WageRegion, number>;
}

export const MIN_WAGE_PERIODS: readonly MinWagePeriod[] = [
  {
    effectiveFrom: '2024-07-01',
    effectiveTo: '2025-12-31',
    basis: 'Nghị định 74/2024/NĐ-CP',
    regions: { I: 4_960_000, II: 4_410_000, III: 3_860_000, IV: 3_450_000 },
  },
  {
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    basis: 'Nghị định 293/2025/NĐ-CP',
    regions: { I: 5_310_000, II: 4_730_000, III: 4_140_000, IV: 3_700_000 },
  },
];

/** Số ngày công chuẩn/tháng dùng chia lương giờ (khoản 2 Điều 55 NĐ 145/2020) */
export const STANDARD_WORK_HOURS = 8;
export const STANDARD_WORK_DAYS = 26;

function findPeriod<T extends { effectiveFrom: string; effectiveTo: string | null }>(
  periods: readonly T[],
  at: Date,
): T {
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    const p = periods[i]!;
    const from = new Date(`${p.effectiveFrom}T00:00:00Z`);
    const to = p.effectiveTo ? new Date(`${p.effectiveTo}T23:59:59Z`) : null;
    if (at >= from && (to === null || at <= to)) return p;
  }
  return periods[0]!;
}

/** Mức tham chiếu tại một thời điểm */
export function getReferenceSalary(at: Date | string): number {
  return findPeriod(REFERENCE_SALARY_PERIODS, new Date(at)).amount;
}

/** Mức lương tối thiểu vùng tại một thời điểm */
export function getMinWage(region: WageRegion, at: Date | string): number {
  const period = findPeriod(MIN_WAGE_PERIODS, new Date(at));
  const amount = period.regions[region];
  if (amount === undefined) {
    throw new Error(`Vùng lương tối thiểu không hợp lệ: ${region}`);
  }
  return amount;
}

/** Trần đóng BHXH & BHYT tại một thời điểm */
export function getSiCap(at: Date | string): number {
  return getReferenceSalary(at) * SI_CAP_MULTIPLIER;
}

/** Trần đóng BHTN tại một thời điểm, theo vùng nơi NLĐ làm việc */
export function getUiCap(region: WageRegion, at: Date | string): number {
  return getMinWage(region, at) * UI_CAP_MULTIPLIER;
}

/** Snapshot toàn bộ tham số pháp lý — lưu vào PayRun.policySnapshot để tái lập */
export interface PolicySnapshot {
  asOf: string;
  referenceSalary: number;
  referenceSalaryBasis: string;
  siCap: number;
  minWage: Record<WageRegion, number>;
  minWageBasis: string;
  uiCapByRegion: Record<WageRegion, number>;
  rates: InsuranceRates;
  standardWorkHours: number;
  standardWorkDays: number;
}

export function buildPolicySnapshot(
  asOf: Date | string,
  rates: InsuranceRates = DEFAULT_INSURANCE_RATES,
): PolicySnapshot {
  const d = new Date(asOf);
  const refPeriod = findPeriod(REFERENCE_SALARY_PERIODS, d);
  const mwPeriod = findPeriod(MIN_WAGE_PERIODS, d);
  const regions: WageRegion[] = ['I', 'II', 'III', 'IV'];
  return {
    asOf: d.toISOString(),
    referenceSalary: refPeriod.amount,
    referenceSalaryBasis: refPeriod.basis,
    siCap: refPeriod.amount * SI_CAP_MULTIPLIER,
    minWage: { ...mwPeriod.regions },
    minWageBasis: mwPeriod.basis,
    uiCapByRegion: Object.fromEntries(
      regions.map((r) => [r, mwPeriod.regions[r]! * UI_CAP_MULTIPLIER]),
    ) as Record<WageRegion, number>,
    rates,
    standardWorkHours: STANDARD_WORK_HOURS,
    standardWorkDays: STANDARD_WORK_DAYS,
  };
}
