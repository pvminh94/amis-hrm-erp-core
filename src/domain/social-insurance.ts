/**
 * ============================================================================
 * TÍNH TRÍCH NỘP BHXH / BHYT / BHTN / BHTNLĐ-BNN
 * ============================================================================
 *
 * Điểm mấu chốt thường bị làm SAI ở phần mềm lương:
 *   - BHXH & BHYT áp trần = 20 × MỨC THAM CHIẾU
 *   - BHTN               áp trần = 20 × MỨC LƯƠNG TỐI THIỂU VÙNG
 *   => HAI TRẦN KHÁC NHAU. Nhiều hệ thống dùng chung một trần => sai.
 *
 *   Ví dụ (từ 01/07/2026, vùng I):
 *     NLĐ lương hợp đồng 60.000.000 đ
 *       căn cứ đóng BHXH/BHYT = min(60.000.000, 50.600.000) = 50.600.000
 *       căn cứ đóng BHTN      = min(60.000.000, 106.200.000) = 60.000.000
 *
 * Tỷ lệ:
 *   NLĐ   10.5% = BHXH 8% + BHYT 1.5% + BHTN 1%
 *   NSDLĐ 21.5% = BHXH 17% + BHYT 3% + BHTN 1% + BHTNLĐ-BNN 0.5%
 *
 * Căn cứ pháp lý: Luật BHXH 2024 (Điều 31, 33), Luật Việc làm 2025 (Điều 34),
 * Nghị định 145/2020/NĐ-CP, NĐ 161/2026/NĐ-CP, NĐ 293/2025/NĐ-CP.
 */

import {
  DEFAULT_INSURANCE_RATES,
  EMPLOYEE_TOTAL_RATE,
  EMPLOYER_TOTAL_RATE,
  type InsuranceRates,
  type WageRegion,
  getReferenceSalary,
  getSiCap,
  getUiCap,
} from '../config/insurance.js';
import { roundVnd } from './money.js';

export interface InsuranceInput {
  /** Tiền lương làm căn cứ đóng (lương hợp đồng + các khoản bổ sung cố định) */
  contractSalary: number;
  /** Vùng lương tối thiểu nơi NLĐ làm việc */
  wageRegion: WageRegion;
  /** Thời điểm tính (quyết định mức tham chiếu / LTTV áp dụng) */
  asOf: Date | string;
  /** Cờ tham gia từng loại bảo hiểm */
  mandatory?: { si?: boolean; hi?: boolean; ui?: boolean };
  /** Ghi đè căn cứ đóng do HR khai (vd đang nghỉ thai sản, nghỉ không lương) */
  baseOverride?: number | null;
  /** NLĐ làm việc tại nơi có LTTV cao hơn mức lương tối thiểu vùng >= 7%
   *  hoặc đã qua đào tạo nghề => cộng thêm 7%/5% vào LTTV khi so sàn.
   *  (khoản 1 Điều 90 BLLĐ 2019) */
  applyFloorUplift?: boolean;
  rates?: InsuranceRates;
}

export interface InsuranceResult {
  /** Căn cứ đóng BHXH/BHYT sau khi áp trần và sàn */
  siBase: number;
  /** Căn cứ đóng BHTN sau khi áp trần và sàn */
  uiBase: number;
  /** Trần đã áp dụng — lưu lại để giải trình với cơ quan BHXH */
  siCapApplied: number;
  uiCapApplied: number;
  referenceSalary: number;
  minWage: number;
  siCapHit: boolean;
  uiCapHit: boolean;
  floorApplied: boolean;
  employee: {
    si: number; // 8%
    hi: number; // 1.5%
    ui: number; // 1%
    total: number; // 10.5%
  };
  employer: {
    si: number; // 17%
    hi: number; // 3%
    ui: number; // 1%
    wci: number; // 0.5% BHTNLĐ-BNN
    total: number; // 21.5%
  };
  /** Tổng chi phí doanh nghiệp gánh chịu (21.5%) */
  totalEmployerCost: number;
  /** Tổng chi phí thực của doanh nghiệp cho NLĐ = gross + 21.5% */
  totalCostToCompany: number;
  notes: string[];
}

/** Hệ số nâng sàn LTTV theo khoản 1 Điều 90 BLLĐ 2019 */
export const MIN_WAGE_UPLIFT_TRAINED = 0.07; // đã qua học nghề: +7%
export const MIN_WAGE_UPLIFT_HAZARD = 0.05; // công việc nặng nhọc độc hại: +5%

export function computeInsurance(
  input: InsuranceInput,
  grossForCompanyCost?: number,
): InsuranceResult {
  const rates = input.rates ?? DEFAULT_INSURANCE_RATES;
  const mand = { si: true, hi: true, ui: true, ...(input.mandatory ?? {}) };
  const notes: string[] = [];

  const referenceSalary = getReferenceSalary(input.asOf);
  const siCap = getSiCap(input.asOf);
  const rawMinWage = getUiCap(input.wageRegion, input.asOf) / 20; // LTTV vùng
  const uiCap = getUiCap(input.wageRegion, input.asOf);

  // --- Sàn: HAI SÀN KHÁC NHAU, tương tự như hai trần -------------------------
  //   BHXH/BHYT: không thấp hơn MỨC THAM CHIẾU  (điểm đ khoản 1 Điều 31 Luật BHXH 2024)
  //   BHTN     : không thấp hơn MỨC LƯƠNG TỐI THIỂU VÙNG (Điều 90 BLLĐ 2019)
  const upliftedMinWage = input.applyFloorUplift
    ? Math.round(rawMinWage * (1 + MIN_WAGE_UPLIFT_TRAINED))
    : rawMinWage;
  if (input.applyFloorUplift) {
    notes.push(
      `Sàn LTTV +7% (công việc đã qua đào tạo nghề, khoản 1 Điều 90 BLLĐ 2019): ${upliftedMinWage.toLocaleString('vi-VN')} đ`,
    );
  }
  const siFloorLaw = referenceSalary;
  const uiFloorLaw = upliftedMinWage;

  const contract = roundVnd(input.contractSalary);
  if (contract <= 0) {
    throw new Error(`Lương hợp đồng phải > 0, nhận: ${contract}`);
  }

  const declaredBase = input.baseOverride !== null && input.baseOverride !== undefined
    ? roundVnd(input.baseOverride)
    : contract;

  // BHXH/BHYT: [mức tham chiếu, 20 × mức tham chiếu]
  // KHÔNG dùng LTTV làm sàn cho BHXH — hai loại bảo hiểm có sàn pháp lý riêng.
  const siFloor = siFloorLaw;
  let siBase = Math.min(Math.max(declaredBase, siFloor), siCap);
  const siCapHit = declaredBase > siCap;
  if (siCapHit) {
    notes.push(
      `Lương ${declaredBase.toLocaleString('vi-VN')} đ vượt trần BHXH/BHYT ${siCap.toLocaleString('vi-VN')} đ (20 × mức tham chiếu ${referenceSalary.toLocaleString('vi-VN')} đ) — áp trần`,
    );
  }

  // BHTN: [LTTV vùng (có thể +7%), 20 × LTTV vùng]
  let uiBase = Math.min(Math.max(declaredBase, uiFloorLaw), uiCap);
  const uiCapHit = declaredBase > uiCap;
  if (uiCapHit) {
    notes.push(
      `Vượt trần BHTN ${uiCap.toLocaleString('vi-VN')} đ (20 × LTTV vùng ${input.wageRegion} = ${rawMinWage.toLocaleString('vi-VN')} đ) — áp trần`,
    );
  }

  if (!mand.si) siBase = 0;
  if (!mand.ui) uiBase = 0;
  const hiBase = mand.hi ? siBase : 0; // BHYT dùng chung trần với BHXH

  const emp = {
    si: roundVnd(siBase * rates.employee.si),
    hi: roundVnd(hiBase * rates.employee.hi),
    ui: roundVnd(uiBase * rates.employee.ui),
  };
  const empl = {
    si: roundVnd(siBase * rates.employer.si),
    hi: roundVnd(hiBase * rates.employer.hi),
    ui: roundVnd(uiBase * rates.employer.ui),
    wci: roundVnd(siBase * rates.employer.wci),
  };

  const employeeTotal = emp.si + emp.hi + emp.ui;
  const employerTotal = empl.si + empl.hi + empl.ui + empl.wci;

  // Kiểm tra chéo: tổng phải khớp 10.5% / 21.5% (sai lệch chỉ do làm tròn ≤ 3đ)
  const expectedEmp = roundVnd(siBase * EMPLOYEE_TOTAL_RATE);
  if (mand.si && mand.hi && mand.ui && Math.abs(employeeTotal - expectedEmp) > 3) {
    notes.push(
      `CẢNH BÁO: tổng khấu trừ NLĐ ${employeeTotal} lệch ${employeeTotal - expectedEmp}đ so với 10.5% (${expectedEmp}) — kiểm tra làm tròn`,
    );
  }
  const expectedEmpl = roundVnd(siBase * EMPLOYER_TOTAL_RATE);
  if (mand.si && mand.hi && mand.ui && Math.abs(employerTotal - expectedEmpl) > 3) {
    notes.push(
      `CẢNH BÁO: tổng chi NSDLĐ ${employerTotal} lệch ${employerTotal - expectedEmpl}đ so với 21.5% (${expectedEmpl})`,
    );
  }

  return {
    siBase: siBase,
    uiBase: uiBase,
    siCapApplied: siCap,
    uiCapApplied: uiCap,
    referenceSalary,
    minWage: rawMinWage,
    siCapHit,
    uiCapHit,
    floorApplied: declaredBase < siFloor,
    employee: { ...emp, total: employeeTotal },
    employer: { ...empl, total: employerTotal },
    totalEmployerCost: employerTotal,
    totalCostToCompany: roundVnd(grossForCompanyCost ?? 0) + employerTotal,
    notes,
  };
}

/**
 * Số phải nộp cho cơ quan BHXH trong kỳ (gộp NLĐ + NSDLĐ) — dùng cho UNC
 * và đối chiếu mẫu C12-TS.
 */
export function computeInsurancePayable(r: InsuranceResult): {
  si: number;
  hi: number;
  ui: number;
  wci: number;
  total: number;
} {
  const si = r.employee.si + r.employer.si;
  const hi = r.employee.hi + r.employer.hi;
  const ui = r.employee.ui + r.employer.ui;
  const wci = r.employer.wci;
  return { si, hi, ui, wci, total: si + hi + ui + wci };
}
