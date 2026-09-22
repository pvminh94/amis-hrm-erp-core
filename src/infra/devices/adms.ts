/**
 * ============================================================================
 * ADMS / PUSH SDK LISTENER — Ronald Jack, ZKTeco (và các máy clone)
 * ============================================================================
 *
 * Ở chế độ ADMS (Auto Data Master Server), máy chấm công CHỦ ĐỘNG gửi HTTP POST
 * tới server. Server trả về "lệnh" trong response body để điều khiển máy.
 *
 * Các endpoint máy sẽ gọi:
 *   POST /deviceconnect.php  → đăng ký thiết bị, heartbeat
 *        query: sn=<serial>&options=CMD=DATA&information=...
 *   POST /attendance/att/attendance.php   → đẩy log quẹt thẻ
 *        body:  ID=9001\t2026-03-05 08:01:23\t0\t255\t0\t0\t0\r\n...
 *   POST /attendance/dev/cmd   → kết quả thực thi lệnh
 *
 * Định dạng bản ghi ATTLOG (tab phân tách, 7 cột):
 *   [0] Số thẻ / PIN nhân viên trên máy
 *   [1] Ngày giờ  "YYYY-MM-DD HH:mm:ss"
 *   [2] Trạng thái xác thực (0/1/255 = không xác định; 1=IN, 0=OUT nếu máy cấu hình)
 *   [3] Mã chế độ xác thực (0=password, 1=vân tay, 15=khuôn mặt, 200=thẻ...)
 *   [4] Số công việc / job code
 *   [5] Mã ca (shift)
 *   [6] Bàn phím nhập (0 = từ máy)
 *
 * Các lệnh server trả về (mỗi dòng một lệnh, kết thúc bằng \n):
 *   DATA UPDATE USERINFO / DATA UPDATE BIOPHOTO / DATA DELETE ATTLOG /
 *   DATA CLEAR / AC SET TIME / ...
 *
 * Tham chiếu: ZKTeco Push Protocol (ADMS) — "Device Management & Attendance".
 */

import { createHash } from 'node:crypto';

export interface AdmsPunchRecord {
  /** Số thẻ/PIN trên máy */
  deviceUserId: string;
  /** Thời điểm quẹt (đã parse) */
  punchAt: Date;
  /** Chuỗi gốc "YYYY-MM-DD HH:mm:ss" */
  punchAtRaw: string;
  /** Trạng thái xác thực (0/1/255) */
  verifyState: number;
  /** Chế độ xác thực: 15 = FaceID, 1 = vân tay, 200 = thẻ */
  workCode: number;
  jobCode: number;
  shiftCode: number;
  /** Bàn phím nhập */
  keypad: number;
  /** Dòng gốc — giữ để đối soát */
  rawLine: string;
}

export interface AdmsDeviceInfo {
  serialNumber: string;
  /** Các tham số máy khai báo trong lần đăng ký */
  params: Record<string, string>;
}

export type AdmsCommand =
  | 'IDLE'
  | 'UPDATE_USERINFO'
  | 'UPDATE_BIOPHOTO'
  | 'DELETE_ATTLOG'
  | 'CLEAR_DATA'
  | 'SET_TIME'
  | 'UPDATE_ATTLOG_PARAM';

/**
 * Parse chuỗi ngày giờ của máy chấm công.
 * Máy ZKTeco/RJ thường gửi GIỜ ĐỊA PHƯƠNG không kèm múi giờ.
 */
export function parseDeviceDateTime(raw: string, tzOffsetHours = 7): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`Định dạng ngày giờ thiết bị không hợp lệ: "${raw}"`);
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const utcMs = new Date(`${iso}.000Z`).getTime() - tzOffsetHours * 3_600_000;
  const dt = new Date(utcMs);
  if (Number.isNaN(dt.getTime())) throw new Error(`Ngày giờ thiết bị không parse được: "${raw}"`);
  return dt;
}

/**
 * Parse body của yêu cầu đẩy ATTLOG.
 * Bỏ qua dòng rỗng và dòng không đủ cột (log lỗi của máy).
 */
export function parseAdmsAttendanceBody(
  body: string,
  tzOffsetHours = 7,
): { records: AdmsPunchRecord[]; skipped: string[] } {
  const records: AdmsPunchRecord[] = [];
  const skipped: string[] = [];

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Một số máy gửi kèm prefix "ATTLOG\t" hoặc "OPLOG\t"
    const payload = trimmed.replace(/^(ATTLOG|OPLOG|PICLOG)\t/, '');
    const cols = payload.split('\t');
    if (cols.length < 7) {
      skipped.push(line);
      continue;
    }
    try {
      records.push({
        deviceUserId: cols[0]!.trim(),
        punchAtRaw: cols[1]!.trim(),
        punchAt: parseDeviceDateTime(cols[1]!, tzOffsetHours),
        verifyState: Number(cols[2]) || 0,
        workCode: Number(cols[3]) || 0,
        jobCode: Number(cols[4]) || 0,
        shiftCode: Number(cols[5]) || 0,
        keypad: Number(cols[6]) || 0,
        rawLine: line,
      });
    } catch (e) {
      skipped.push(line);
    }
  }
  return { records, skipped };
}

/** Parse query string đăng ký thiết bị */
export function parseAdmsRegistration(query: Record<string, string | undefined>): AdmsDeviceInfo {
  const sn = (query.sn ?? '').trim();
  if (!sn) throw new Error('Yêu cầu đăng ký ADMS thiếu tham số sn (serial number)');
  const params: Record<string, string> = {};
  const info = query.information ?? query.options ?? '';
  // Dạng: "CMD=DATA&VENDOR=ZKTeco&VER=...&..."
  for (const pair of info.split('&')) {
    const idx = pair.indexOf('=');
    if (idx > 0) params[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return { serialNumber: sn, params };
}

/** Sinh chuỗi lệnh trả về cho máy (response body của ADMS) */
export function buildAdmsResponse(commands: AdmsCommand[] = [], payload: Record<string, string> = {}): string {
  if (commands.length === 0) return '';
  const lines: string[] = [];
  for (const cmd of commands) {
    const args = Object.entries(payload)
      .map(([k, v]) => `\t${k}=${v}`)
      .join('');
    switch (cmd) {
      case 'UPDATE_USERINFO':
        lines.push(`DATA UPDATE USERINFO${args}`);
        break;
      case 'UPDATE_BIOPHOTO':
        lines.push(`DATA UPDATE BIOPHOTO${args}`);
        break;
      case 'DELETE_ATTLOG':
        lines.push(`DATA DELETE ATTLOG${args}`);
        break;
      case 'CLEAR_DATA':
        lines.push(`DATA CLEAR${args}`);
        break;
      case 'SET_TIME':
        lines.push(`AC SET TIME ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\t`);
        break;
      default:
        lines.push(cmd);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Khoá khử trùng lặp: cùng một quẹt (máy + số thẻ + thời điểm tới giây)
 * chỉ được ghi MỘT lần. Máy ADMS gửi lại log nhiều lần khi mất mạng.
 */
export function admsDedupeHash(serialNumber: string, deviceUserId: string, punchAt: Date): string {
  const ts = Math.floor(punchAt.getTime() / 1000);
  return createHash('sha256').update(`${serialNumber}|${deviceUserId}|${ts}`).digest('hex');
}

/**
 * Map "chế độ xác thực" của máy sang nguồn dữ liệu.
 * 15/200 = FaceID (nhiều model dùng 15, một số dùng 200 cho thẻ)
 */
export function mapWorkCodeToSource(workCode: number): 'FACE' | 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'UNKNOWN' {
  switch (workCode) {
    case 15:
    case 16:
    case 201:
      return 'FACE';
    case 1:
    case 12:
    case 14:
      return 'FINGERPRINT';
    case 200:
      return 'CARD';
    case 0:
    case 9:
      return 'PASSWORD';
    default:
      return 'UNKNOWN';
  }
}
