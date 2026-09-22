/**
 * Tiền tệ: LUÔN dùng số nguyên VND (Int). Tuyệt đối không dùng Float.
 * Mọi phép tính trung gian dùng number nhưng kết quả cuối được làm tròn
 * về đồng nguyên theo quy tắc kế toán Việt Nam (round-half-up).
 */

/** Làm tròn half-up về số nguyên đồng. (-0.5 => 0, 0.5 => 1, 2.5 => 3) */
export function roundVnd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) + 0.5);
}

/** Làm tròn xuống bội số của step (vd step=1000 => 12.450 -> 12.000) */
export function roundDownTo(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return roundVnd(value);
  return Math.floor(value / step) * step;
}

/** Giới hạn value vào [min, max] */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Tổng an toàn, bỏ qua NaN/Infinity */
export function sumVnd(values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (Number.isFinite(v)) total += v;
  }
  return roundVnd(total);
}

/** Định dạng hiển thị kiểu Việt Nam: 12.345.678 ₫ */
export function formatVnd(value: number, currency = '₫'): string {
  const rounded = roundVnd(value);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toString();
  const grouped = abs.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped} ${currency}`;
}

/** Tỷ lệ thập phân -> chuỗi phần trăm hiển thị: 0.105 -> "10,5%" */
export function formatRate(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits).replace('.', ',')}%`;
}

/** Nhân tỷ lệ và làm tròn về đồng */
export function applyRate(base: number, rate: number): number {
  return roundVnd(base * rate);
}
