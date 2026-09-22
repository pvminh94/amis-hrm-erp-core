/**
 * ============================================================================
 * THUẾ THU NHẬP CÁ NHÂN — BIỂU LUỸ TIẾN TỪNG PHẦN
 * ============================================================================
 *
 * Hỗ trợ CẢ HAI chế độ (xem src/config/tax-regime.ts):
 *   - LEGACY_7B  : biểu 7 bậc (Luật TNCN 2007) + giảm trừ 11tr / 4.4tr
 *                  — đúng nguyên văn spec, dùng cho kỳ lương ≤ 2025
 *   - VN_2026_5B : biểu 5 bậc (Luật 109/2025/QH15) + giảm trừ 15.5tr / 6.2tr
 *                  — quy định HIỆN HÀNH cho kỳ 2026 trở đi
 *
 * Quy trình tính (Điều 7, 9 Thông tư 111/2013/TT-BTC, được kế thừa bởi
 * Luật 109/2025/QH15):
 *
 *   1. Thu nhập chịu thuế = Tổng thu nhập − các khoản MIỄN THUẾ
 *      (OT, phụ cấp đêm, trợ cấp... — xem income-tax.ts phần miễn thuế)
 *   2. Các khoản giảm trừ:
 *        a. Bảo hiểm bắt buộc NLĐ đóng (10.5%)
 *        b. Giảm trừ gia cảnh bản thân
 *        c. Giảm trừ người phụ thuộc (mỗi NPT chỉ tính 1 lần cho 1 NNT)
 *        d. Đóng góp từ thiện/nhân đạo/khuyến học có chứng từ
 *        e. Đóng quỹ hưu trí tự nguyện (tối đa 1.000.000 đ/tháng)
 *        f. Chi y tế, giáo dục-đào tạo (mở rộng theo Luật 109/2025)
 *   3. Thu nhập tính thuế = max(0, TNTT chịu thuế − tổng giảm trừ)
 *   4. Thuế = Σ (phần thu nhập trong bậc × thuế suất bậc đó)
 *      tương đương công thức rút gọn: Thuế = TNTT × thuế_suất − số_trừ_nhanh
 *
 * Làm tròn: số thuế làm tròn đến ĐỒNG theo half-up.
 */

import {
  type TaxBracket,
  type TaxRegime,
  REGIME_LEGACY_7B,
  resolveTaxRegime,
} from '../config/tax-regime.js';
import { roundVnd } from './money.js';

export interface PitInput {
  /** Tổng thu nhập đã LOẠI TRỪ các khoản miễn thuế (OT, phụ cấp đêm...) */
  assessableIncome: number;
  /** Tổng bảo hiểm bắt buộc NLĐ đã trích (10.5%) */
  mandatoryInsurance: number;
  /** Số người phụ thuộc đủ điều kiện giảm trừ trong kỳ */
  dependents: number;
  /** Chế độ thuế; null/'AUTO' => tự chọn theo kỳ */
  regime?: TaxRegime | string | null;
  /** Ngày cuối kỳ lương — dùng để tự chọn chế độ */
  periodEnd: Date | string;
  /** Ghi đè giảm trừ bản thân (vd NLĐ không cư trú, hoặc đã giảm trừ nơi khác) */
  selfDeductionOverride?: number | null;
  /** Có áp dụng giảm trừ gia cảnh không? (không cư trú / vãng lai = false) */
  applyFamilyDeduction?: boolean;
  /** Giảm trừ khác có chứng từ */
  charityDonation?: number;
  /** Đóng quỹ hưu trí tự nguyện */
  voluntaryPension?: number;
  /** Chi y tế, giáo dục-đào tạo (Luật 109/2025 mở rộng) */
  medicalEducation?: number;
}

export interface BracketDetail {
  level: number;
  /** Phần thu nhập rơi vào bậc này */
  portion: number;
  rate: number;
  tax: number;
}

export interface PitResult {
  regimeCode: string;
  regimeName: string;
  legalBasis: string;
  assessableIncome: number;
  deductions: {
    insurance: number;
    self: number;
    dependents: number;
    dependentCount: number;
    perDependent: number;
    charity: number;
    voluntaryPension: number;
    medicalEducation: number;
    total: number;
  };
  taxableIncome: number;
  brackets: BracketDetail[];
  tax: number;
  /** Thuế suất hiệu dụng trên thu nhập chịu thuế */
  effectiveRate: number;
  /** Kiểm tra chéo bằng công thức rút gọn */
  quickFormulaTax: number;
  quickFormulaMatch: boolean;
  notes: string[];
}

/**
 * Tính thuế theo biểu luỹ tiến TỪNG PHẦN — chia thu nhập vào từng bậc,
 * KHÔNG nhân toàn bộ thu nhập với thuế suất cao nhất.
 */
export function computeProgressiveTax(taxableIncome: number, brackets: readonly TaxBracket[]): {
  tax: number;
  brackets: BracketDetail[];
} {
  if (taxableIncome <= 0) return { tax: 0, brackets: [] };

  const details: BracketDetail[] = [];
  let total = 0;
  for (const b of brackets) {
    // Chỉ xét bậc khi thu nhập VƯỢT cận dưới của bậc đó.
    // (thu nhập = đúng cận dưới => phần trong bậc = 0 => không sinh dòng)
    if (taxableIncome <= b.from) break;
    const portion = Math.min(taxableIncome, b.to) - b.from;
    if (portion <= 0) continue; // phòng vệ: không ghi dòng 0đ vào chi tiết giải trình
    const tax = portion * b.rate;
    total += tax;
    details.push({ level: b.level, portion: roundVnd(portion), rate: b.rate, tax: roundVnd(tax) });
  }
  return { tax: roundVnd(total), brackets: details };
}

/** Công thức rút gọn: Thuế = TNTT × thuế_suất_bậc − số_trừ_nhanh */
export function computeQuickFormulaTax(taxableIncome: number, brackets: readonly TaxBracket[]): number {
  if (taxableIncome <= 0) return 0;
  const b = brackets.find((x) => taxableIncome > x.from && taxableIncome <= x.to);
  if (!b) {
    const last = brackets[brackets.length - 1]!;
    return roundVnd(taxableIncome * last.rate - last.quickDeduction);
  }
  return roundVnd(taxableIncome * b.rate - b.quickDeduction);
}

/**
 * Hàm chính: tính thuế TNCN phải nộp trong kỳ.
 */
export function computePersonalIncomeTax(input: PitInput): PitResult {
  const regime: TaxRegime =
    input.regime && typeof input.regime !== 'string'
      ? input.regime
      : resolveTaxRegime(input.periodEnd, typeof input.regime === 'string' ? input.regime : null);

  const notes: string[] = [];
  const assessable = roundVnd(input.assessableIncome);
  if (assessable < 0) {
    throw new Error(`Thu nhập chịu thuế không được âm: ${assessable}`);
  }

  const applyFamily = input.applyFamilyDeduction !== false;

  const insurance = roundVnd(Math.max(0, input.mandatoryInsurance));
  const self = applyFamily
    ? (input.selfDeductionOverride !== undefined && input.selfDeductionOverride !== null
        ? roundVnd(input.selfDeductionOverride)
        : regime.selfDeduction)
    : 0;

  const dependentCount = applyFamily ? Math.max(0, Math.floor(input.dependents)) : 0;
  if (applyFamily && input.dependents !== dependentCount) {
    notes.push(
      `Số người phụ thuộc ${input.dependents} được làm tròn xuống ${dependentCount} (không tính NPT lẻ)`,
    );
  }
  if (!applyFamily) {
    notes.push('Không áp dụng giảm trừ gia cảnh (thu nhập vãng lai / cá nhân không cư trú)');
  }

  const perDependent = regime.dependentDeduction;
  const dependentsTotal = dependentCount * perDependent;

  // Trần quỹ hưu trí tự nguyện
  const cap = regime.voluntaryPensionCap;
  let pension = roundVnd(Math.max(0, input.voluntaryPension ?? 0));
  if (pension > cap) {
    notes.push(`Đóng quỹ hưu trí tự nguyện ${pension.toLocaleString('vi-VN')}đ vượt trần — chỉ trừ ${cap.toLocaleString('vi-VN')}đ`);
    pension = cap;
  }

  const charity = roundVnd(Math.max(0, input.charityDonation ?? 0));
  const medEdu = roundVnd(Math.max(0, input.medicalEducation ?? 0));

  const totalDeduction = insurance + self + dependentsTotal + charity + pension + medEdu;
  const taxableIncome = Math.max(0, assessable - totalDeduction);

  const { tax, brackets } = computeProgressiveTax(taxableIncome, regime.brackets);
  const quickFormulaTax = computeQuickFormulaTax(taxableIncome, regime.brackets);

  // Kiểm tra chéo hai phương pháp — chênh lệch chỉ được do làm tròn (≤ 2đ)
  const quickFormulaMatch = Math.abs(tax - quickFormulaTax) <= 2;
  if (!quickFormulaMatch) {
    notes.push(
      `LỆCH giữa luỹ tiến từng phần (${tax.toLocaleString('vi-VN')}đ) và công thức rút gọn (${quickFormulaTax.toLocaleString('vi-VN')}đ) — kiểm tra cấu hình biểu thuế`,
    );
  }

  if (assessable > 0 && taxableIncome === 0) {
    notes.push('Thu nhập tính thuế = 0 sau giảm trừ gia cảnh — không phát sinh thuế TNCN');
  }

  return {
    regimeCode: regime.code,
    regimeName: regime.name,
    legalBasis: regime.legalBasis,
    assessableIncome: assessable,
    deductions: {
      insurance,
      self,
      dependents: dependentsTotal,
      dependentCount,
      perDependent,
      charity,
      voluntaryPension: pension,
      medicalEducation: medEdu,
      total: totalDeduction,
    },
    taxableIncome,
    brackets,
    tax,
    effectiveRate: assessable > 0 ? tax / assessable : 0,
    quickFormulaTax,
    quickFormulaMatch,
    notes,
  };
}

/**
 * Thuế TNCN cho thu nhập VÃNG LAI / hợp đồng dưới 3 tháng:
 * khấu trừ 10% tại nguồn nếu tổng thu nhập ≥ 2.000.000 đ/lần.
 * (điểm i khoản 1 Điều 25 Thông tư 111/2013/TT-BTC)
 */
export function computeOccasionalIncomeTax(
  income: number,
  regime: TaxRegime = REGIME_LEGACY_7B,
  hasCommitment08?: boolean,
): { tax: number; withheld: boolean; notes: string[] } {
  const notes: string[] = [];
  const amount = roundVnd(income);
  if (hasCommitment08) {
    notes.push('Có bản cam kết 08/CK-TNCN (ước tính tổng thu nhập chưa tới ngưỡng) — tạm không khấu trừ');
    return { tax: 0, withheld: false, notes };
  }
  if (amount < regime.occasionalIncomeThreshold) {
    notes.push(`Dưới ngưỡng ${regime.occasionalIncomeThreshold.toLocaleString('vi-VN')}đ/lần — không khấu trừ 10%`);
    return { tax: 0, withheld: false, notes };
  }
  return { tax: roundVnd(amount * 0.1), withheld: true, notes };
}
