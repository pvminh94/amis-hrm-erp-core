import { createHash, randomBytes } from 'node:crypto';

/**
 * ============================================================================
 * HIKVISION ISAPI / HTTP LISTENING — nhận sự kiện FaceID theo thời gian thực
 * ============================================================================
 *
 * Thiết bị Hikvision (Dòng DS-K1T / DS-K56 / iDS-...) hỗ trợ 2 chế độ đẩy dữ liệu:
 *
 *  (A) HTTP LISTENING (ISAPI Event Notification):
 *      Thiết bị POST tới endpoint đã cấu hình, body dạng multipart/mixed với
 *      phần XML <EventNotificationAlert> và phần ảnh JPEG (nhận diện khuôn mặt).
 *
 *  (B) ISAPI chủ động (server pull):
 *      GET  /ISAPI/AccessControl/UserInfo/Record?searchID=...
 *      GET  /ISAPI/AccessControl/AcsEvent?format=json
 *      POST /ISAPI/AccessControl/AcsCfg   (đồng bộ thời gian, tham số)
 *
 * Payload sự kiện JSON điển hình (Content-Type: application/json):
 * {
 *   "EventNotificationAlert": {
 *     "ipAddress": "192.168.1.64",
 *     "portNo": 80,
 *     "protocol": "HTTP",
 *     "macAddress": "ac:cf:23:xx:xx:xx",
 *     "channelID": 1,
 *     "dateTime": "2026-03-05T08:01:23+07:00",
 *     "activePostCount": 1,
 *     "eventType": "AccessControllerEvent",
 *     "eventState": "active",
 *     "eventDescription": "Access Controller Event",
 *     "AccessControllerEvent": {
 *        "deviceName": "Cua chinh",
 *        "majorEventType": 5,
 *        "subEventType": 75,
 *        "name": "Nguyen Van A",
 *        "cardNo": "1234567",
 *        "cardType": 1,
 *        "currentVerifyMode": "cardOrFace",
 *        "serialNo": 12,
 *        "shortUserID": 1,
 *        "pictureURL": "http://..."
 *     }
 *   }
 * }
 *
 * majorEventType 5 + subEventType 75  = "Valid event" (xác thực thành công)
 * majorEventType 5 + subEventType 26..30 = các lỗi xác thực (không hợp lệ,
 *   hết hạn thẻ, sai mật khẩu, KHÔNG ĐẠT LIVENESS...)
 */

export interface HikvisionAcsEvent {
  deviceName?: string;
  majorEventType?: number;
  subEventType?: number;
  name?: string;
  cardNo?: string;
  cardType?: number;
  currentVerifyMode?: string;
  serialNo?: number;
  shortUserID?: number;
  employeeNo?: string;
  pictureURL?: string;
  temperature?: number;
  currTemperature?: number;
  mask?: string;
}

export interface HikvisionEventAlert {
  ipAddress?: string;
  portNo?: number;
  macAddress?: string;
  channelID?: number;
  dateTime?: string;
  activePostCount?: number;
  eventType?: string;
  eventState?: string;
  eventDescription?: string;
  AccessControllerEvent?: HikvisionAcsEvent;
  VideoIntercomEvent?: HikvisionAcsEvent;
}

export interface ParsedHikvisionPunch {
  /** Số nhân viên trên thiết bị (employeeNo/cardNo) */
  deviceUserId: string;
  personName: string | null;
  punchAt: Date;
  macAddress: string | null;
  ipAddress: string | null;
  serialNo: number | null;
  verifyMode: string | null;
  /** Ảnh khuôn mặt đi kèm (nếu multipart) */
  picture?: Buffer;
  raw: unknown;
  accepted: boolean;
  rejectReason?: string;
}

/** Sự kiện xác thực HỢP LỆ (thành công) */
export const ACS_VALID_SUB_EVENTS = new Set([
  75, // valid event
  76, // card + password super password
  29, // (một số firmware) first card open
]);

/** Sự kiện xác thực THẤT BẠI */
export const ACS_INVALID_SUB_EVENTS: Record<number, string> = {
  26: 'Thẻ không hợp lệ',
  27: 'Thẻ hết hạn',
  28: 'Thẻ bị liệt vào danh sách đen',
  30: 'Sai mật khẩu',
  31: 'Sai vân tay',
  32: 'Sai mật khẩu và vân tay',
  33: 'Sai mật khẩu hoặc vân tay',
  34: 'Sai khuôn mặt',
  35: 'Không đạt kiểm tra chống giả mạo (anti-spoofing)',
  36: 'Khuôn mặt không khớp thẻ',
  37: 'Nhiệt độ cơ thể vượt ngưỡng',
  38: 'Không đeo khẩu trang',
  41: 'Xác thực kép thất bại',
  44: 'Không có quyền trong khung giờ',
};

/**
 * Tách body multipart/mixed thành các phần.
 * Hikvision dùng boundary trong Content-Type: multipart/mixed; boundary=boundary1
 */
export function parseMultipartMixed(
  body: Buffer,
  contentType: string,
): Array<{ headers: Record<string, string>; content: Buffer }> {
  const m = /boundary="?([^";\s]+)"?/i.exec(contentType);
  if (!m) throw new Error(`Content-Type multipart thiếu boundary: ${contentType}`);
  const boundary = `--${m[1]}`;
  const text = body.toString('binary');
  const chunks = text.split(boundary).filter((c) => c.trim() !== '' && c.trim() !== '--');

  return chunks.map((chunk) => {
    const clean = chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const sepIdx = clean.indexOf('\r\n\r\n');
    const headerBlock = sepIdx >= 0 ? clean.slice(0, sepIdx) : '';
    const contentStr = sepIdx >= 0 ? clean.slice(sepIdx + 4) : clean;
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return { headers, content: Buffer.from(contentStr, 'binary') };
  });
}

/**
 * Parse sự kiện Hikvision từ body (JSON thuần hoặc multipart/mixed).
 * Trả về null nếu không tìm thấy phần sự kiện.
 */
export function parseHikvisionEvent(
  body: Buffer,
  contentType = 'application/json',
  tzOffsetHours = 7,
): ParsedHikvisionPunch | null {
  let alert: HikvisionEventAlert | null = null;
  let picture: Buffer | undefined;

  if (contentType.toLowerCase().includes('multipart')) {
    const parts = parseMultipartMixed(body, contentType);
    for (const part of parts) {
      const ct = (part.headers['content-type'] ?? '').toLowerCase();
      if (ct.includes('xml') || ct.includes('json')) {
        const text = part.content.toString('utf8').trim();
        alert = extractAlertFromText(text) ?? alert;
      } else if (ct.includes('image')) {
        picture = part.content;
      }
    }
  } else {
    alert = extractAlertFromText(body.toString('utf8').trim());
  }

  if (!alert) return null;

  const acs = alert.AccessControllerEvent ?? alert.VideoIntercomEvent ?? {};
  const deviceUserId = String(acs.employeeNo ?? acs.cardNo ?? '').trim();
  const subEvent = acs.subEventType ?? -1;
  const accepted = ACS_VALID_SUB_EVENTS.has(subEvent);

  return {
    deviceUserId,
    personName: acs.name ?? null,
    punchAt: parseIsoWithOffset(alert.dateTime, tzOffsetHours),
    macAddress: alert.macAddress ?? null,
    ipAddress: alert.ipAddress ?? null,
    serialNo: acs.serialNo ?? null,
    verifyMode: acs.currentVerifyMode ?? null,
    picture,
    raw: alert,
    accepted,
    rejectReason: accepted ? undefined : (ACS_INVALID_SUB_EVENTS[subEvent] ?? `subEventType=${subEvent}`),
  };
}

/** Nhận cả JSON lẫn XML tối giản (chỉ trích trường cần thiết) */
function extractAlertFromText(text: string): HikvisionEventAlert | null {
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const alert = (obj.EventNotificationAlert ?? obj) as HikvisionEventAlert | undefined;
      // JSON hợp lệ nhưng KHÔNG phải sự kiện ISAPI (body rác, health-check, ...)
      // => trả null để webhook đáp 400 gọn gàng. Ném lỗi ở đây sẽ thành HTTP 500
      // và thiết bị sẽ retry vô hạn.
      if (!alert || typeof alert !== 'object') return null;
      const looksLikeAlert =
        typeof alert.dateTime === 'string' ||
        alert.AccessControllerEvent !== undefined ||
        alert.VideoIntercomEvent !== undefined;
      return looksLikeAlert ? alert : null;
    } catch {
      return null;
    }
  }
  if (text.startsWith('<')) {
    const get = (tag: string): string | undefined => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
      return m ? m[1]!.trim() : undefined;
    };
    const acsBlock = /<AccessControllerEvent>([\s\S]*?)<\/AccessControllerEvent>/.exec(text);
    const acs: HikvisionAcsEvent = {};
    if (acsBlock) {
      const inner = acsBlock[1]!;
      const g = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(inner)?.[1]?.trim();
      acs.name = g('name');
      acs.cardNo = g('cardNo');
      acs.employeeNo = g('employeeNo');
      acs.majorEventType = Number(g('majorEventType') ?? '') || undefined;
      acs.subEventType = Number(g('subEventType') ?? '') || undefined;
      acs.currentVerifyMode = g('currentVerifyMode');
      acs.serialNo = Number(g('serialNo') ?? '') || undefined;
    }
    return {
      ipAddress: get('ipAddress'),
      macAddress: get('macAddress'),
      channelID: Number(get('channelID') ?? '') || undefined,
      dateTime: get('dateTime'),
      eventType: get('eventType'),
      eventState: get('eventState'),
      AccessControllerEvent: acs,
    };
  }
  return null;
}

/**
 * Parse ISO8601 có offset ("2026-03-05T08:01:23+07:00").
 * Nếu thiết bị gửi KHÔNG kèm offset (một số firmware), giả định múi giờ cục bộ.
 */
export function parseIsoWithOffset(raw: string | undefined, tzOffsetHours = 7): Date {
  if (!raw) throw new Error('Sự kiện Hikvision thiếu trường dateTime');
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(raw);
  const iso = hasOffset ? raw : `${raw}+${String(tzOffsetHours).padStart(2, '0')}:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`dateTime không hợp lệ: "${raw}"`);
  return d;
}

// ---------------------------------------------------------------------------
// SINH REQUEST ĐỂ CẤU HÌNH THIẾT BỊ (server → device)
// ---------------------------------------------------------------------------

/** XML dùng cho PUT /ISAPI/System/Network/Integrate (HTTP Listening) */
export function buildHttpListeningXml(opts: {
  hostAddress: string;
  port: number;
  url: string;
  protocolType?: 'HTTP' | 'HTTPS';
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<HttpHostNotificationList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">',
    '  <HttpHostNotification>',
    '    <id>1</id>',
    `    <url>${escapeXml(opts.url)}</url>`,
    `    <protocolType>${opts.protocolType ?? 'HTTP'}</protocolType>`,
    `    <parameterFormatType>XML</parameterFormatType>`,
    `    <addressingFormatType>ipaddress</addressingFormatType>`,
    `    <ipAddress>${escapeXml(opts.hostAddress)}</ipAddress>`,
    `    <portNo>${opts.port}</portNo>`,
    '    <httpAuthenticationMethod>none</httpAuthenticationMethod>',
    '  </HttpHostNotification>',
    '</HttpHostNotificationList>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// DIGEST AUTHENTICATION (RFC 2617) — thiết bị Hikvision bắt buộc dùng Digest
// ---------------------------------------------------------------------------

/**
 * Bóc tách header `WWW-Authenticate: Digest ...` mà thiết bị trả về ở lần
 * gọi 401 đầu tiên. Trả về null nếu không phải Digest.
 */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
  charset?: string;
  stale?: string;
}

export function isDigestChallenge(header: string | null | undefined): boolean {
  return !!header && /^digest\s/i.test(header.trim());
}

export function parseDigestChallenge(header: string | null | undefined): DigestChallenge | null {
  if (!isDigestChallenge(header)) return null;
  const body = header!.trim().replace(/^digest\s+/i, '');
  const out: Record<string, string> = {};
  // key="value" hoặc key=value
  const re = /([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(?:"([^"]*)"|([^,]+))/g;
  for (const m of body.matchAll(re)) {
    out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  if (!out.realm || !out.nonce) return null;
  return {
    realm: out.realm!,
    nonce: out.nonce!,
    qop: out.qop,
    opaque: out.opaque,
    algorithm: out.algorithm,
    charset: out.charset,
    stale: out.stale,
  };
}

/**
 * Sinh header `Authorization: Digest ...` theo RFC 2617 (qop="auth").
 *
 *   HA1 = MD5(username:realm:password)
 *   HA2 = MD5(method:digestURI)
 *   response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
 *
 * Thiết bị Hikvision (ISAPI) chỉ chấp nhận MD5, không phải SHA-256,
 * nên đây là trường hợp hiếm hoi MD5 là bắt buộc chứ không phải tuỳ chọn.
 */
export function buildDigestAuthHeader(opts: {
  username: string;
  password: string;
  realm: string;
  nonce: string;
  method: string;
  uri: string;
  qop?: string;
  nc?: string | number;
  cnonce?: string;
  opaque?: string;
}): string {
  const qop = opts.qop ?? 'auth';
  const nc = typeof opts.nc === 'number' ? formatNonceCount(opts.nc) : (opts.nc ?? '00000001');
  const cnonce = opts.cnonce ?? randomBytes(8).toString('hex');

  const md5 = (input: string): string => createHash('md5').update(input, 'utf8').digest('hex');

  const ha1 = md5(`${opts.username}:${opts.realm}:${opts.password}`);
  const ha2 = md5(`${opts.method.toUpperCase()}:${opts.uri}`);
  const response = qop
    ? md5(`${ha1}:${opts.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${opts.nonce}:${ha2}`);

  const parts = [
    `username="${opts.username}"`,
    `realm="${opts.realm}"`,
    `nonce="${opts.nonce}"`,
    `uri="${opts.uri}"`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opts.opaque) parts.push(`opaque="${opts.opaque}"`);

  return `Digest ${parts.join(', ')}`;
}

/**
 * Chuỗi `nc` đúng chuẩn: 8 chữ số hex. Một số firmware từ chối `nc=1`.
 */
export function formatNonceCount(nc: number): string {
  return nc.toString(16).padStart(8, '0');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );
}
