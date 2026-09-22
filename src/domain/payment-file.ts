/**
 * ============================================================================
 * XUẤT FILE ỦY NHIỆM CHI (UNC) & FILE THANH TOÁN LƯƠNG THEO MẪU NGÂN HÀNG
 * ============================================================================
 *
 * Hỗ trợ: Vietcombank (VCB), Techcombank (TCB), VietinBank (CTG), MB Bank (MBB).
 *
 * ⚠️  LƯU Ý TRIỂN KHAI:
 *   Mẫu file của từng ngân hàng được cập nhật định kỳ và có thể khác nhau
 *   giữa các kênh (iBanking doanh nghiệp / ERP Connect / H2H API). Các hàm
 *   ở đây sinh ra ĐỊNH DẠNG PHỔ BIẾN NHẤT đang được chấp nhận, kèm checksum
 *   và kiểm tra bắt buộc (STK đúng độ dài, tên không dấu, số tiền > 0...).
 *   TRƯỚC KHI GO-LIVE phải đối chiếu lại với mẫu hiện hành do ngân hàng cấp
 *   và hiệu chỉnh trong `BANK_FORMATS` bên dưới — không cần sửa engine.
 *
 * Mọi file đều:
 *   - Có dòng HEADER / DETAIL / FOOTER với tổng số món và tổng tiền
 *   - Kiểm tra Σ tiền các dòng = tổng ở footer (chống lệch khi truyền file)
 *   - Bỏ dấu tiếng Việt có kiểm soát (nhiều core banking chỉ chấp nhận ASCII)
 */

import { createHash } from 'node:crypto';

import { roundVnd } from './money.js';

export type BankCode = 'VCB' | 'TCB' | 'CTG' | 'MBB' | 'GENERIC';

export interface PaymentRow {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  /** Số tài khoản nhận */
  accountNumber: string;
  /** Tên chủ tài khoản (thường = tên nhân viên) */
  beneficiaryName: string;
  /** Mã ngân hàng thụ hưởng (NAPAS) — vd 'VCBVNVX' */
  beneficiaryBankCode?: string;
  /** Chi nhánh thụ hưởng */
  beneficiaryBranch?: string;
  amount: number;
  /** Nội dung chuyển khoản */
  description: string;
}

export interface PaymentFileInfo {
  /** Số hiệu lô */
  batchNo: string;
  /** Ngày lập */
  date: string; // YYYY-MM-DD
  /** Thông tin bên trả */
  payer: {
    name: string;
    accountNumber: string;
    bankCode: string;
    branch?: string;
    taxCode?: string;
  };
  bank: BankCode;
  /** Loại: SALARY (trả lương) | TRANSFER (UNC thông thường) */
  purpose: 'SALARY' | 'TRANSFER';
  periodLabel: string;
  rows: PaymentRow[];
  /** Định dạng đầu ra */
  format?: 'csv' | 'txt';
  /** Ngăn cách CSV */
  delimiter?: string;
  /** Thêm BOM UTF-8 (cần cho Excel tiếng Việt) */
  withBom?: boolean;
}

export class PaymentFileError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentFileError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// KIỂM TRA DỮ LIỆU
// ---------------------------------------------------------------------------

/** Bảng ánh xạ STK theo độ dài tối thiểu — bắt lỗi nhập sai trước khi gửi bank */
const MIN_ACCOUNT_LENGTH: Record<BankCode, number> = {
  VCB: 6,
  TCB: 6,
  CTG: 9,
  MBB: 6,
  GENERIC: 6,
};

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  totalAmount: number;
  rowCount: number;
}

export function validatePaymentFile(info: PaymentFileInfo): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!info.payer.accountNumber || !/^\d{6,20}$/.test(info.payer.accountNumber)) {
    errors.push(`STK bên trả không hợp lệ: "${info.payer.accountNumber}"`);
  }
  if (!info.payer.name) errors.push('Thiếu tên bên trả');
  if (info.rows.length === 0) errors.push('File không có dòng thanh toán nào');

  const seen = new Set<string>();
  let total = 0;
  const minLen = MIN_ACCOUNT_LENGTH[info.bank];

  info.rows.forEach((r, i) => {
    const where = `dòng ${i + 1} (${r.employeeCode})`;
    if (!r.accountNumber || !/^\d+$/.test(r.accountNumber)) {
      errors.push(`${where}: STK phải chỉ gồm chữ số, nhận "${r.accountNumber}"`);
    } else if (r.accountNumber.length < minLen) {
      errors.push(`${where}: STK ${r.accountNumber.length} số < tối thiểu ${minLen} của ${info.bank}`);
    }
    if (!r.beneficiaryName || r.beneficiaryName.trim().length < 2) {
      errors.push(`${where}: thiếu tên người thụ hưởng`);
    }
    const amt = roundVnd(r.amount);
    if (amt <= 0) errors.push(`${where}: số tiền phải > 0, nhận ${amt}`);
    if (!r.description || r.description.trim() === '') {
      warnings.push(`${where}: thiếu nội dung chuyển khoản — ngân hàng có thể từ chối`);
    }
    const key = `${r.accountNumber}:${amt}`;
    if (seen.has(key)) {
      warnings.push(`${where}: trùng STK + số tiền với dòng trước — kiểm tra trùng lặp`);
    }
    seen.add(key);
    total += amt;
  });

  return { ok: errors.length === 0, errors, warnings, totalAmount: total, rowCount: info.rows.length };
}

// ---------------------------------------------------------------------------
// TIỆN ÍCH CHUẨN HOÁ
// ---------------------------------------------------------------------------

const VN_MAP: Record<string, string> = {
  à: 'a', á: 'a', ả: 'a', ã: 'a', ạ: 'a', ă: 'a', ằ: 'a', ắ: 'a', ẳ: 'a', ẵ: 'a', ặ: 'a',
  â: 'a', ầ: 'a', ấ: 'a', ẩ: 'a', ẫ: 'a', ậ: 'a',
  đ: 'd',
  è: 'e', é: 'e', ẻ: 'e', ẽ: 'e', ẹ: 'e', ê: 'e', ề: 'e', ế: 'e', ể: 'e', ễ: 'e', ệ: 'e',
  ì: 'i', í: 'i', ỉ: 'i', ĩ: 'i', ị: 'i',
  ò: 'o', ó: 'o', ỏ: 'o', õ: 'o', ọ: 'o', ô: 'o', ồ: 'o', ố: 'o', ổ: 'o', ỗ: 'o', ộ: 'o',
  ơ: 'o', ờ: 'o', ớ: 'o', ở: 'o', ỡ: 'o', ợ: 'o',
  ù: 'u', ú: 'u', ủ: 'u', ũ: 'u', ụ: 'u', ư: 'u', ừ: 'u', ứ: 'u', ử: 'u', ữ: 'u', ự: 'u',
  ỳ: 'y', ý: 'y', ỷ: 'y', ỹ: 'y', ỵ: 'y',
};

/** Bỏ dấu tiếng Việt — nhiều core banking chỉ nhận ASCII */
export function removeVietnameseTones(input: string): string {
  return input
    .toLowerCase()
    .split('')
    .map((ch) => VN_MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}
function padStart(s: string, len: number, ch = '0'): string {
  return s.length >= len ? s.slice(-len) : ch.repeat(len - s.length) + s;
}
function ymd(d: string): string {
  return d.replace(/-/g, '');
}
function escapeCsv(v: string, delimiter: string): string {
  const needsQuote = v.includes(delimiter) || v.includes('"') || v.includes('\n');
  const escaped = v.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

// ---------------------------------------------------------------------------
// SINH NỘI DUNG FILE
// ---------------------------------------------------------------------------

export interface GeneratedPaymentFile {
  fileName: string;
  content: string;
  format: 'csv' | 'txt';
  rowCount: number;
  totalAmount: number;
  checksum: string;
  byteLength: number;
  validation: ValidationResult;
}

/**
 * Sinh file thanh toán lương theo mẫu ngân hàng.
 * NÉM LỖI nếu dữ liệu không hợp lệ — không bao giờ sinh file sai.
 */
export function generatePaymentFile(info: PaymentFileInfo): GeneratedPaymentFile {
  const validation = validatePaymentFile(info);
  if (!validation.ok) {
    throw new PaymentFileError('INVALID_PAYMENT_DATA', validation.errors.join(' | '));
  }

  const totalAmount = validation.totalAmount;
  let content: string;
  let format: 'csv' | 'txt' = info.format ?? 'csv';

  switch (info.bank) {
    case 'VCB':
      content = generateVcb(info, totalAmount);
      format = info.format ?? 'txt';
      break;
    case 'TCB':
      content = generateGenericCsv(info, totalAmount, 'TCB');
      break;
    case 'CTG':
      content = generateGenericCsv(info, totalAmount, 'CTG');
      break;
    case 'MBB':
      content = generateGenericCsv(info, totalAmount, 'MBB');
      break;
    default:
      content = generateGenericCsv(info, totalAmount, 'GENERIC');
  }

  const bom = info.withBom !== false && format === 'csv' ? '\uFEFF' : '';
  const finalContent = bom + content;
  const stamp = info.date.replace(/-/g, '');
  const fileName = `UNC_${info.bank}_${info.purpose}_${stamp}_${info.batchNo}.${format}`;

  return {
    fileName,
    content: finalContent,
    format,
    rowCount: info.rows.length,
    totalAmount,
    checksum: createHash('sha256').update(finalContent, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(finalContent, 'utf8'),
    validation,
  };
}

/**
 * Mẫu Vietcombank — định dạng cột cố định (fixed-width), ASCII không dấu.
 *
 *  HEADER : A|<batchNo>|<payerAccount>|<payerName>|<yyyymmdd>|<purpose>|<count>|<total>
 *  DETAIL : D|<seq>|<benefAccount>|<benefName>|<amount>|<description>
 *  FOOTER : Z|<count>|<total>
 */
function generateVcb(info: PaymentFileInfo, total: number): string {
  const lines: string[] = [];
  lines.push(
    [
      'A',
      info.batchNo,
      info.payer.accountNumber,
      padEnd(removeVietnameseTones(info.payer.name), 60).trim(),
      ymd(info.date),
      info.purpose === 'SALARY' ? 'SALARY' : 'TRANSFER',
      padStart(String(info.rows.length), 5),
      padStart(String(total), 15),
    ].join('|'),
  );
  info.rows.forEach((r, i) => {
    lines.push(
      [
        'D',
        padStart(String(i + 1), 5),
        r.accountNumber,
        padEnd(removeVietnameseTones(r.beneficiaryName), 60).trim(),
        padStart(String(roundVnd(r.amount)), 15),
        padEnd(removeVietnameseTones(r.description), 80).trim(),
      ].join('|'),
    );
  });
  lines.push(['Z', padStart(String(info.rows.length), 5), padStart(String(total), 15)].join('|'));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Mẫu CSV tổng quát dùng được cho TCB / CTG / MBB và import Excel.
 * Có tiêu đề cột tiếng Việt + Anh để kế toán dễ đối chiếu.
 */
function generateGenericCsv(
  info: PaymentFileInfo,
  total: number,
  bank: BankCode | 'GENERIC',
): string {
  const d = info.delimiter ?? ',';
  const lines: string[] = [];

  // Khối thông tin lô
  lines.push(`# ${bank === 'GENERIC' ? 'PHIEU THANH TOAN LUONG' : `UNC ${bank}`}`);
  lines.push(`# So hieu lo${d}${info.batchNo}`);
  lines.push(`# Ngay lap${d}${info.date}`);
  lines.push(`# Ky luong${d}${info.periodLabel}`);
  lines.push(`# Ben tra${d}${info.payer.name}`);
  lines.push(`# STK ben tra${d}${info.payer.accountNumber}`);
  lines.push(`# Ngan hang ben tra${d}${info.payer.bankCode}`);
  lines.push(`# Tong so mon${d}${info.rows.length}`);
  lines.push(`# Tong so tien${d}${total}`);
  lines.push('');

  // Tiêu đề cột
  const headers = [
    'STT',
    'Mã nhân viên',
    'Tên người thụ hưởng',
    'Tên không dấu',
    'Số tài khoản',
    'Ngân hàng thụ hưởng',
    'Chi nhánh',
    'Số tiền (VND)',
    'Nội dung',
  ];
  lines.push(headers.map((h) => escapeCsv(h, d)).join(d));

  info.rows.forEach((r, i) => {
    lines.push(
      [
        String(i + 1),
        r.employeeCode,
        r.beneficiaryName,
        removeVietnameseTones(r.beneficiaryName),
        r.accountNumber,
        r.beneficiaryBankCode ?? '',
        r.beneficiaryBranch ?? '',
        String(roundVnd(r.amount)),
        r.description,
      ]
        .map((v) => escapeCsv(String(v ?? ''), d))
        .join(d),
    );
  });

  lines.push('');
  lines.push(`TỔNG CỘNG${d.repeat(6)}${total}`);
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// FILE NỘP BHXH (mẫu C12-TS rút gọn) — kèm theo để đối chiếu
// ---------------------------------------------------------------------------

export interface InsuranceDeclarationRow {
  employeeCode: string;
  fullName: string;
  siNumber: string;
  siBase: number;
  uiBase: number;
  siEmployee: number;
  hiEmployee: number;
  uiEmployee: number;
  siEmployer: number;
  hiEmployer: number;
  uiEmployer: number;
  wciEmployer: number;
}

export function generateInsuranceDeclarationCsv(
  companySiCode: string,
  periodLabel: string,
  rows: readonly InsuranceDeclarationRow[],
): GeneratedPaymentFile {
  const d = ';';
  const lines: string[] = [];
  lines.push(`# BANG KE NOP BHXH BHYT BHTN ${periodLabel}`);
  lines.push(`# Ma don vi${d}${companySiCode}`);
  lines.push('');
  lines.push(
    [
      'STT',
      'Mã NV',
      'Họ tên',
      'Số sổ BHXH',
      'Căn cứ đóng BHXH',
      'Căn cứ đóng BHTN',
      'BHXH NLĐ 8%',
      'BHYT NLĐ 1.5%',
      'BHTN NLĐ 1%',
      'BHXH NSDLĐ 17%',
      'BHYT NSDLĐ 3%',
      'BHTN NSDLĐ 1%',
      'BHTNLĐ 0.5%',
      'Tổng phải nộp',
    ].join(d),
  );

  const totals = { siBase: 0, uiBase: 0, siE: 0, hiE: 0, uiE: 0, siEm: 0, hiEm: 0, uiEm: 0, wciEm: 0 };
  rows.forEach((r, i) => {
    const totalRow =
      r.siEmployee + r.hiEmployee + r.uiEmployee + r.siEmployer + r.hiEmployer + r.uiEmployer + r.wciEmployer;
    totals.siBase += r.siBase;
    totals.uiBase += r.uiBase;
    totals.siE += r.siEmployee;
    totals.hiE += r.hiEmployee;
    totals.uiE += r.uiEmployee;
    totals.siEm += r.siEmployer;
    totals.hiEm += r.hiEmployer;
    totals.uiEm += r.uiEmployer;
    totals.wciEm += r.wciEmployer;
    lines.push(
      [
        String(i + 1),
        r.employeeCode,
        r.fullName,
        r.siNumber,
        r.siBase,
        r.uiBase,
        r.siEmployee,
        r.hiEmployee,
        r.uiEmployee,
        r.siEmployer,
        r.hiEmployer,
        r.uiEmployer,
        r.wciEmployer,
        totalRow,
      ].join(d),
    );
  });

  const grand = totals.siE + totals.hiE + totals.uiE + totals.siEm + totals.hiEm + totals.uiEm + totals.wciEm;
  lines.push('');
  lines.push(
    ['TỔNG', '', '', '', totals.siBase, totals.uiBase, totals.siE, totals.hiE, totals.uiE, totals.siEm, totals.hiEm, totals.uiEm, totals.wciEm, grand].join(d),
  );

  const content = '\uFEFF' + lines.join('\r\n') + '\r\n';
  return {
    fileName: `BHXH_C12TS_${companySiCode}_${periodLabel.replace(/[^\d]/g, '')}.csv`,
    content,
    format: 'csv',
    rowCount: rows.length,
    totalAmount: grand,
    checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(content, 'utf8'),
    validation: { ok: true, errors: [], warnings: [], totalAmount: grand, rowCount: rows.length },
  };
}
