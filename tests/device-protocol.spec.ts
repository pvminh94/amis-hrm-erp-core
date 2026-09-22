/**
 * ============================================================================
 * TEST — PARSER GIAO THỨC THIẾT BỊ CHẤM CÔNG
 * ============================================================================
 *
 *   - ADMS/Push SDK (ZKTeco, Ronald Jack): ATTLOG / OPLOG / PICLOG
 *   - Hikvision ISAPI (FaceID): JSON + XML + multipart + Digest Auth + anti-spoofing
 *
 * Đây là tầng dễ sai nhất và khó phát hiện nhất khi chạy thật với thiết bị —
 * sai một cột hoặc một mốc thời gian là hỏng cả tháng chấm công, nên phải
 * được khoá chặt bằng test.
 */

import { describe, expect, it } from 'vitest';

import {
  admsDedupeHash,
  buildAdmsResponse,
  mapWorkCodeToSource,
  parseAdmsAttendanceBody,
  parseAdmsRegistration,
  parseDeviceDateTime,
  type AdmsCommand,
} from '../src/infra/devices/adms.js';
import {
  ACS_INVALID_SUB_EVENTS,
  ACS_VALID_SUB_EVENTS,
  buildDigestAuthHeader,
  buildHttpListeningXml,
  formatNonceCount,
  isDigestChallenge,
  parseDigestChallenge,
  parseHikvisionEvent,
  parseIsoWithOffset,
  parseMultipartMixed,
} from '../src/infra/devices/hikvision-isapi.js';
import {
  haversineDistanceM,
  normalizeBssid,
  pointInPolygon,
  validateGpsPunch,
} from '../src/domain/geofence.js';

const json = (o: unknown): Buffer => Buffer.from(JSON.stringify(o), 'utf8');

// ---------------------------------------------------------------------------
// ADMS / Push SDK
// ---------------------------------------------------------------------------

describe('ADMS — parseDeviceDateTime (giờ máy là giờ địa phương, không kèm múi giờ)', () => {
  it('07:58 ICT phải thành 00:58 UTC', () => {
    expect(parseDeviceDateTime('2026-03-05 07:58:12').toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('quẹt đêm 23:30 vẫn đúng ngày', () => {
    expect(parseDeviceDateTime('2026-03-05 23:30:00').toISOString()).toBe('2026-03-05T16:30:00.000Z');
  });

  it('ca đêm kết thúc 06:04 sáng hôm sau — chốt công vẫn thuộc về ngày hôm trước', () => {
    const d = parseDeviceDateTime('2026-03-06 06:04:11');
    expect(d.toISOString()).toBe('2026-03-05T23:04:11.000Z');
  });

  it('chấp nhận cả dấu T thay khoảng trắng (một số firmware)', () => {
    expect(parseDeviceDateTime('2026-03-05T07:58:12').toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('TỪ CHỐI ngày sai định dạng thay vì sinh mốc thời gian bậy', () => {
    expect(() => parseDeviceDateTime('05/03/2026 07:58:12')).toThrow();
    expect(() => parseDeviceDateTime('2026-3-5 07:58:12')).toThrow();
    expect(() => parseDeviceDateTime('not-a-date')).toThrow();
    expect(() => parseDeviceDateTime('')).toThrow();
  });

  it('cho phép đổi múi giờ cho thiết bị ở nước khác', () => {
    // Cùng chuỗi giờ, múi giờ +9 thì UTC sớm hơn 2 tiếng so với +7
    const vn = parseDeviceDateTime('2026-03-05 09:00:00', 7);
    const jp = parseDeviceDateTime('2026-03-05 09:00:00', 9);
    expect(vn.getTime() - jp.getTime()).toBe(2 * 3_600_000);
  });
});

describe('ADMS — mapWorkCodeToSource (mã xác thực → nguồn chấm công)', () => {
  it('15/16/201 là FACE', () => {
    expect(mapWorkCodeToSource(15)).toBe('FACE');
    expect(mapWorkCodeToSource(16)).toBe('FACE');
    expect(mapWorkCodeToSource(201)).toBe('FACE');
  });

  it('1/12/14 là FINGERPRINT', () => {
    expect(mapWorkCodeToSource(1)).toBe('FINGERPRINT');
    expect(mapWorkCodeToSource(12)).toBe('FINGERPRINT');
    expect(mapWorkCodeToSource(14)).toBe('FINGERPRINT');
  });

  it('200 là CARD, 0/9 là PASSWORD', () => {
    expect(mapWorkCodeToSource(200)).toBe('CARD');
    expect(mapWorkCodeToSource(0)).toBe('PASSWORD');
    expect(mapWorkCodeToSource(9)).toBe('PASSWORD');
  });

  it('mã lạ KHÔNG được đoán mò — trả UNKNOWN để HR soát', () => {
    expect(mapWorkCodeToSource(99)).toBe('UNKNOWN');
    expect(mapWorkCodeToSource(-1)).toBe('UNKNOWN');
    expect(mapWorkCodeToSource(255)).toBe('UNKNOWN');
  });
});

describe('ADMS — parseAdmsAttendanceBody (7 cột chuẩn ATTLOG)', () => {
  const LINE = '1001\t2026-03-05 07:58:12\t15\t15\t0\t0\t0';

  it('parse đúng đủ 7 cột', () => {
    const { records, skipped } = parseAdmsAttendanceBody(LINE);
    expect(skipped).toHaveLength(0);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.deviceUserId).toBe('1001');
    expect(r.punchAtRaw).toBe('2026-03-05 07:58:12');
    expect(r.punchAt.toISOString()).toBe('2026-03-05T00:58:12.000Z');
    expect(r.verifyState).toBe(15);
    expect(r.workCode).toBe(15);
    expect(mapWorkCodeToSource(r.workCode)).toBe('FACE');
    expect(r.rawLine).toBe(LINE); // giữ nguyên để đối soát
  });

  it('bóc tiền tố ATTLOG/OPLOG/PICLOG do máy gửi kèm', () => {
    for (const prefix of ['ATTLOG\t', 'OPLOG\t', 'PICLOG\t']) {
      const { records } = parseAdmsAttendanceBody(prefix + LINE);
      expect(records).toHaveLength(1);
      expect(records[0]!.deviceUserId).toBe('1001');
    }
  });

  it('ít hơn 7 cột bị bỏ vào skipped, KHÔNG lọt vào records', () => {
    const { records, skipped } = parseAdmsAttendanceBody('1001\t2026-03-05 07:58:12\t15');
    expect(records).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('ngày hỏng chỉ làm hỏng DÒNG ĐÓ, cả lô vẫn chạy', () => {
    const body = [
      '1001\t2026-03-05 07:58:12\t15\t15\t0\t0\t0',
      '1002\t2026-13-45 07:58:12\t15\t15\t0\t0\t0',
      '1003\t2026-03-05 08:01:00\t1\t1\t0\t0\t0',
    ].join('\n');
    const { records, skipped } = parseAdmsAttendanceBody(body);
    expect(records).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(records.map((r) => r.deviceUserId)).toEqual(['1001', '1003']);
  });

  it('bỏ qua dòng rỗng, không phá cả lô', () => {
    const body = `\n1001\t2026-03-05 07:58:12\t15\t15\t0\t0\t0\n   \n`;
    const { records, skipped } = parseAdmsAttendanceBody(body);
    expect(records).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('xử lý đúng CRLF (thiết bị firmware Windows)', () => {
    const body = '1001\t2026-03-05 07:58:12\t15\t15\t0\t0\t0\r\n1002\t2026-03-05 08:01:00\t15\t15\t0\t0\t0\r\n';
    const { records } = parseAdmsAttendanceBody(body);
    expect(records).toHaveLength(2);
  });

  it('cột số hỏng thì về 0 chứ không làm sập batch', () => {
    const { records } = parseAdmsAttendanceBody('1001\t2026-03-05 07:58:12\txx\tyy\t0\t0\t0');
    expect(records[0]!.verifyState).toBe(0);
    expect(records[0]!.workCode).toBe(0);
  });
});

describe('ADMS — parseAdmsRegistration (thiết bị đăng ký lần đầu)', () => {
  it('lấy serial number và tham số máy', () => {
    const info = parseAdmsRegistration({
      sn: 'RJ-W600-002',
      information: 'CMD=DATA&VENDOR=Ronald Jack&VER=6.60&IP=192.168.1.50',
    });
    expect(info.serialNumber).toBe('RJ-W600-002');
    expect(info.params.VENDOR).toBe('Ronald Jack');
    expect(info.params.IP).toBe('192.168.1.50');
  });

  it('thiếu sn thì báo lỗi rõ ràng — không ghi quẹt mồ côi', () => {
    expect(() => parseAdmsRegistration({ sn: '' })).toThrow(/sn/);
    expect(() => parseAdmsRegistration({})).toThrow(/sn/);
  });
});

describe('ADMS — buildAdmsResponse (lệnh trả về cho thiết bị)', () => {
  it('không có lệnh => body rỗng (thiết bị hiểu là ACK)', () => {
    expect(buildAdmsResponse([])).toBe('');
    expect(buildAdmsResponse()).toBe('');
  });

  it('yêu cầu đồng bộ lại USERINFO + BIOPHOTO kèm tham số', () => {
    const resp = buildAdmsResponse(['UPDATE_USERINFO', 'UPDATE_BIOPHOTO'], { PIN: '1001' });
    expect(resp).toContain('DATA UPDATE USERINFO');
    expect(resp).toContain('DATA UPDATE BIOPHOTO');
    expect(resp).toContain('\tPIN=1001');
    expect(resp.endsWith('\n')).toBe(true);
  });

  it('xoá log đã nhận để thiết bị không đẩy lại mãi', () => {
    expect(buildAdmsResponse(['DELETE_ATTLOG'])).toContain('DATA DELETE ATTLOG');
  });

  it('xoá sạch dữ liệu trên máy', () => {
    expect(buildAdmsResponse(['CLEAR_DATA'])).toContain('DATA CLEAR');
  });

  it('đồng bộ giờ máy chủ — chống máy lệch giờ làm hỏng công đêm', () => {
    const resp = buildAdmsResponse(['SET_TIME']);
    expect(resp).toMatch(/^AC SET TIME \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('gộp nhiều lệnh trong một response', () => {
    const cmds: AdmsCommand[] = ['UPDATE_USERINFO', 'DELETE_ATTLOG', 'SET_TIME'];
    expect(buildAdmsResponse(cmds).trim().split('\n')).toHaveLength(3);
  });
});

describe('ADMS — dedupe hash (chống máy đẩy lại log khi mất mạng)', () => {
  it('cùng quẹt => cùng hash', () => {
    const a = admsDedupeHash('SN001', '1001', new Date('2026-03-05T00:58:12.000Z'));
    const b = admsDedupeHash('SN001', '1001', new Date('2026-03-05T00:58:12.999Z'));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('khác giây / khác người / khác máy => khác hash', () => {
    const base = admsDedupeHash('SN001', '1001', new Date('2026-03-05T00:58:12.000Z'));
    expect(admsDedupeHash('SN001', '1001', new Date('2026-03-05T00:58:13.000Z'))).not.toBe(base);
    expect(admsDedupeHash('SN001', '1002', new Date('2026-03-05T00:58:12.000Z'))).not.toBe(base);
    expect(admsDedupeHash('SN002', '1001', new Date('2026-03-05T00:58:12.000Z'))).not.toBe(base);
  });

  it('cùng quẹt nhưng ở hai máy khác nhau không được khử trùng', () => {
    // Nhân viên quẹt ở cổng rồi quẹt ở xưởng — cả hai đều là dữ liệu thật
    const gate = admsDedupeHash('GATE-01', '1001', new Date('2026-03-05T00:58:12.000Z'));
    const plant = admsDedupeHash('PLANT-02', '1001', new Date('2026-03-05T00:58:12.000Z'));
    expect(gate).not.toBe(plant);
  });
});

// ---------------------------------------------------------------------------
// Hikvision ISAPI — sự kiện FaceID
// ---------------------------------------------------------------------------

describe('Hikvision ISAPI — bảng mã sự kiện', () => {
  it('75/76/29 là sự kiện hợp lệ để ghi công', () => {
    expect(ACS_VALID_SUB_EVENTS.has(75)).toBe(true);
    expect(ACS_VALID_SUB_EVENTS.has(76)).toBe(true);
    expect(ACS_VALID_SUB_EVENTS.has(29)).toBe(true);
  });

  it('35 (chống giả mạo thất bại) KHÔNG được tính công', () => {
    expect(ACS_VALID_SUB_EVENTS.has(35)).toBe(false);
    expect(ACS_INVALID_SUB_EVENTS[35]).toMatch(/giả mạo/i);
  });

  it('có lý do tiếng Việt cho các mã lỗi phổ biến', () => {
    expect(ACS_INVALID_SUB_EVENTS[26]).toBeTruthy(); // thẻ không hợp lệ
    expect(ACS_INVALID_SUB_EVENTS[34]).toMatch(/khuôn mặt/i); // sai khuôn mặt
    expect(ACS_INVALID_SUB_EVENTS[37]).toMatch(/nhiệt độ/i);
    expect(ACS_INVALID_SUB_EVENTS[38]).toMatch(/khẩu trang/i);
  });

  it('mã lỗi không được nằm trong danh sách hợp lệ', () => {
    for (const code of Object.keys(ACS_INVALID_SUB_EVENTS)) {
      expect(ACS_VALID_SUB_EVENTS.has(Number(code))).toBe(false);
    }
  });
});

const alert = (over: Record<string, unknown> = {}, acs: Record<string, unknown> = {}) => ({
  ipAddress: '192.168.1.64',
  portNo: 8000,
  macAddress: 'aa:bb:cc:dd:ee:ff',
  channelID: 1,
  dateTime: '2026-03-05T07:58:12+07:00',
  activePostCount: 1,
  eventType: 'ACS',
  eventState: 'active',
  eventDescription: 'Face Recognition',
  AccessControllerEvent: {
    deviceName: 'DS-K1T671M',
    majorEventType: 5,
    subEventType: 75,
    name: 'Trần Minh Tuấn',
    cardNo: '1001',
    employeeNo: '1001',
    currentVerifyMode: 'face',
    serialNo: 42,
    temperature: 36.5,
    mask: 'no',
    ...acs,
  },
  ...over,
});

describe('Hikvision ISAPI — parseHikvisionEvent (JSON)', () => {
  it('parse đúng sự kiện hợp lệ, chấp nhận ghi công', () => {
    const p = parseHikvisionEvent(json({ EventNotificationAlert: alert() }));
    expect(p).not.toBeNull();
    expect(p!.accepted).toBe(true);
    expect(p!.rejectReason).toBeUndefined();
    expect(p!.deviceUserId).toBe('1001');
    expect(p!.personName).toBe('Trần Minh Tuấn');
    expect(p!.macAddress).toBe('aa:bb:cc:dd:ee:ff');
    expect(p!.ipAddress).toBe('192.168.1.64');
    expect(p!.serialNo).toBe(42);
    expect(p!.verifyMode).toBe('face');
    expect(p!.punchAt.toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('subEventType 35 => không chấp nhận, kèm lý do chống giả mạo', () => {
    const p = parseHikvisionEvent(json({ EventNotificationAlert: alert({}, { subEventType: 35 }) }));
    expect(p!.accepted).toBe(false);
    expect(p!.rejectReason).toMatch(/giả mạo/i);
  });

  it('subEventType 37 (sốt) => không chấp nhận', () => {
    const p = parseHikvisionEvent(json({ EventNotificationAlert: alert({}, { subEventType: 37 }) }));
    expect(p!.accepted).toBe(false);
    expect(p!.rejectReason).toMatch(/nhiệt độ/i);
  });

  it('subEventType lạ => không chấp nhận, nêu rõ mã', () => {
    const p = parseHikvisionEvent(json({ EventNotificationAlert: alert({}, { subEventType: 999 }) }));
    expect(p!.accepted).toBe(false);
    expect(p!.rejectReason).toContain('999');
  });

  it('ưu tiên employeeNo, fallback sang cardNo', () => {
    const noEmp = parseHikvisionEvent(
      json({ EventNotificationAlert: alert({}, { employeeNo: undefined, cardNo: '2002' }) }),
    );
    expect(noEmp!.deviceUserId).toBe('2002');
  });

  it('body rác => null (không ném lỗi làm sập webhook)', () => {
    expect(parseHikvisionEvent(Buffer.from('không phải json'))).toBeNull();
    expect(parseHikvisionEvent(Buffer.from('{}'))).toBeNull();
    expect(parseHikvisionEvent(Buffer.from(''))).toBeNull();
  });

  it('thiếu dateTime => ném lỗi rõ ràng chứ không ghi mốc thời gian sai', () => {
    expect(() => parseHikvisionEvent(json({ EventNotificationAlert: alert({ dateTime: undefined }) }))).toThrow(
      /dateTime/,
    );
  });

  it('nhận cả dạng không bọc EventNotificationAlert', () => {
    const p = parseHikvisionEvent(json(alert()));
    expect(p!.deviceUserId).toBe('1001');
  });
});

describe('Hikvision ISAPI — parseIsoWithOffset', () => {
  it('có offset thì dùng offset', () => {
    expect(parseIsoWithOffset('2026-03-05T07:58:12+07:00').toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('firmware không gửi offset => giả định giờ Việt Nam', () => {
    expect(parseIsoWithOffset('2026-03-05T07:58:12').toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('chấp nhận đuôi Z', () => {
    expect(parseIsoWithOffset('2026-03-05T00:58:12Z').toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('rỗng / sai => ném lỗi', () => {
    expect(() => parseIsoWithOffset(undefined)).toThrow();
    expect(() => parseIsoWithOffset('')).toThrow();
    expect(() => parseIsoWithOffset('không-phải-ngày')).toThrow();
  });
});

describe('Hikvision ISAPI — parseHikvisionEvent (XML)', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<EventNotificationAlert version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">',
    '<ipAddress>192.168.1.64</ipAddress>',
    '<macAddress>aa:bb:cc:dd:ee:ff</macAddress>',
    '<channelID>1</channelID>',
    '<dateTime>2026-03-05T07:58:12+07:00</dateTime>',
    '<eventType>ACS</eventType>',
    '<eventState>active</eventState>',
    '<AccessControllerEvent>',
    '<deviceName>DS-K1T671M</deviceName>',
    '<majorEventType>5</majorEventType>',
    '<subEventType>75</subEventType>',
    '<name>Trần Minh Tuấn</name>',
    '<cardNo>1001</cardNo>',
    '<employeeNo>1001</employeeNo>',
    '<currentVerifyMode>face</currentVerifyMode>',
    '<serialNo>42</serialNo>',
    '</AccessControllerEvent>',
    '</EventNotificationAlert>',
  ].join('');

  it('parse XML đúng như JSON (thiết bị cấu hình parameterFormatType=XML)', () => {
    const p = parseHikvisionEvent(Buffer.from(xml), 'application/xml');
    expect(p).not.toBeNull();
    expect(p!.accepted).toBe(true);
    expect(p!.deviceUserId).toBe('1001');
    expect(p!.personName).toBe('Trần Minh Tuấn');
    expect(p!.punchAt.toISOString()).toBe('2026-03-05T00:58:12.000Z');
  });

  it('XML báo lỗi chống giả mạo vẫn bị từ chối', () => {
    const bad = xml.replace('<subEventType>75</subEventType>', '<subEventType>35</subEventType>');
    const p = parseHikvisionEvent(Buffer.from(bad), 'application/xml');
    expect(p!.accepted).toBe(false);
    expect(p!.rejectReason).toMatch(/giả mạo/i);
  });
});

describe('Hikvision ISAPI — multipart/mixed (sự kiện kèm ảnh khuôn mặt)', () => {
  const boundary = 'boundary1';
  const eventPart = JSON.stringify({ EventNotificationAlert: alert() });
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]);

  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, 'binary'),
    Buffer.from('Content-Type: application/json\r\nContent-Length: ' + eventPart.length + '\r\n\r\n', 'binary'),
    Buffer.from(eventPart, 'utf8'),
    Buffer.from(`\r\n--${boundary}\r\n`, 'binary'),
    Buffer.from('Content-Type: image/jpeg\r\nContent-Length: ' + fakeJpeg.length + '\r\n\r\n', 'binary'),
    fakeJpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'binary'),
  ]);

  it('tách được 2 phần: sự kiện và ảnh', () => {
    const parts = parseMultipartMixed(multipart, `multipart/mixed; boundary=${boundary}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.headers['content-type']).toContain('json');
    expect(parts[1]!.headers['content-type']).toContain('image/jpeg');
  });

  it('lấy được cả sự kiện lẫn ảnh để lưu làm bằng chứng chống gian lận', () => {
    const p = parseHikvisionEvent(multipart, `multipart/mixed; boundary=${boundary}`);
    expect(p).not.toBeNull();
    expect(p!.deviceUserId).toBe('1001');
    expect(p!.accepted).toBe(true);
    expect(p!.picture).toBeDefined();
    expect(p!.picture!.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('thiếu boundary trong Content-Type => báo lỗi rõ ràng', () => {
    expect(() => parseMultipartMixed(multipart, 'multipart/mixed')).toThrow(/boundary/);
  });
});

describe('Hikvision ISAPI — buildHttpListeningXml (cấu hình thiết bị đẩy về server)', () => {
  const xml = buildHttpListeningXml({ hostAddress: '192.168.1.10', port: 3000, url: '/api/v1/attendance/devices/hikvision' });

  it('đúng schema HttpHostNotificationList', () => {
    expect(xml).toContain('<HttpHostNotificationList');
    expect(xml).toContain('<ipAddress>192.168.1.10</ipAddress>');
    expect(xml).toContain('<portNo>3000</portNo>');
    expect(xml).toContain('<url>/api/v1/attendance/devices/hikvision</url>');
    expect(xml).toContain('<protocolType>HTTP</protocolType>');
  });

  it('escape XML để không phá payload', () => {
    const dirty = buildHttpListeningXml({ hostAddress: '1.1.1.1', port: 80, url: '/a?x=1&y=<2>' });
    expect(dirty).toContain('&amp;');
    expect(dirty).toContain('&lt;');
    expect(dirty).not.toContain('y=<2>');
  });

  it('hỗ trợ HTTPS', () => {
    expect(
      buildHttpListeningXml({ hostAddress: '1.1.1.1', port: 443, url: '/x', protocolType: 'HTTPS' }),
    ).toContain('<protocolType>HTTPS</protocolType>');
  });
});

// ---------------------------------------------------------------------------
// Digest Authentication (RFC 2617) — bắt buộc để gọi ISAPI
// ---------------------------------------------------------------------------

describe('Hikvision ISAPI — Digest Authentication', () => {
  const CHALLENGE =
    'Digest qop="auth", realm="DS-K1T671M", nonce="5f3a9c1e2b7d4f8a", stale="false", charset="UTF-8"';

  it('nhận diện đúng WWW-Authenticate là Digest', () => {
    expect(isDigestChallenge(CHALLENGE)).toBe(true);
    expect(isDigestChallenge('Digest realm="x", nonce="y"')).toBe(true);
    expect(isDigestChallenge('Basic realm="x"')).toBe(false);
    expect(isDigestChallenge('Bearer token')).toBe(false);
    expect(isDigestChallenge('')).toBe(false);
    expect(isDigestChallenge(null)).toBe(false);
    expect(isDigestChallenge(undefined)).toBe(false);
  });

  it('bóc tách đúng realm, nonce, qop', () => {
    const c = parseDigestChallenge(CHALLENGE)!;
    expect(c.realm).toBe('DS-K1T671M');
    expect(c.nonce).toBe('5f3a9c1e2b7d4f8a');
    expect(c.qop).toBe('auth');
    expect(c.charset).toBe('UTF-8');
    expect(c.stale).toBe('false');
  });

  it('không phải Digest hoặc thiếu nonce => null', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge('Digest realm="x"')).toBeNull();
    expect(parseDigestChallenge(null)).toBeNull();
  });

  it('sinh header Digest đầy đủ', () => {
    const header = buildDigestAuthHeader({
      method: 'GET',
      uri: '/ISAPI/Event/notification/httpHosts',
      username: 'admin',
      password: 'Abc@12345',
      realm: 'DS-K1T671M',
      nonce: '5f3a9c1e2b7d4f8a',
      cnonce: 'c0ffee01',
      nc: 1,
    });

    expect(header.startsWith('Digest ')).toBe(true);
    expect(header).toContain('username="admin"');
    expect(header).toContain('realm="DS-K1T671M"');
    expect(header).toContain('nonce="5f3a9c1e2b7d4f8a"');
    expect(header).toContain('uri="/ISAPI/Event/notification/httpHosts"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('cnonce="c0ffee01"');
    expect(header).toMatch(/response="[0-9a-f]{32}"/); // MD5 = 32 ký tự hex
  });

  it('đúng giá trị MD5 theo RFC 2617 với bộ tham số chuẩn', () => {
    const { createHash } = require('node:crypto');
    const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
    const realm = 'testrealm@host.com';
    const nonce = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = md5('GET:/dir/index.html');
    const expected = md5(`${ha1}:${nonce}:00000001:0a4f113b:auth:${ha2}`);

    const header = buildDigestAuthHeader({
      method: 'GET',
      uri: '/dir/index.html',
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm,
      nonce,
      cnonce: '0a4f113b',
      nc: 1,
    });
    expect(header).toContain(`response="${expected}"`);
  });

  it('response thay đổi theo method / URI / password (không phải hằng số)', () => {
    const resp = (h: string) => /response="([0-9a-f]{32})"/.exec(h)![1]!;
    const base = { username: 'admin', password: 'x', realm: 'r', nonce: 'n', cnonce: 'c', nc: 1 };
    const get = resp(buildDigestAuthHeader({ ...base, method: 'GET', uri: '/a' }));
    expect(resp(buildDigestAuthHeader({ ...base, method: 'PUT', uri: '/a' }))).not.toBe(get);
    expect(resp(buildDigestAuthHeader({ ...base, method: 'GET', uri: '/b' }))).not.toBe(get);
    expect(
      resp(buildDigestAuthHeader({ ...base, password: 'y', method: 'GET', uri: '/a' })),
    ).not.toBe(get);
  });

  it('nc tăng dần và luôn 8 chữ số hex (firmware kén chọn)', () => {
    expect(formatNonceCount(1)).toBe('00000001');
    expect(formatNonceCount(258)).toBe('00000102');
    expect(formatNonceCount(4294967295)).toBe('ffffffff');
    expect(buildDigestAuthHeader({
      method: 'GET', uri: '/x', username: 'a', password: 'b', realm: 'r', nonce: 'n', nc: 258,
    })).toContain('nc=00000102');
  });

  it('không có qop thì bỏ hẳn qop/nc/cnonce (RFC 2069)', () => {
    const header = buildDigestAuthHeader({
      method: 'GET', uri: '/x', username: 'a', password: 'b', realm: 'r', nonce: 'n', qop: '',
    });
    expect(header).not.toContain('qop=');
    expect(header).not.toContain('nc=');
  });

  it('kèm opaque khi thiết bị gửi opaque (bắt buộc phải echo lại)', () => {
    const header = buildDigestAuthHeader({
      method: 'GET', uri: '/x', username: 'a', password: 'b', realm: 'r', nonce: 'n', opaque: '5ccc069c',
    });
    expect(header).toContain('opaque="5ccc069c"');
  });

  it('vòng lặp thật: challenge → parse → header', () => {
    const c = parseDigestChallenge(CHALLENGE)!;
    const header = buildDigestAuthHeader({
      username: 'admin',
      password: 'Abc@12345',
      realm: c.realm,
      nonce: c.nonce,
      method: 'GET',
      uri: '/ISAPI/AccessControl/UserInfo/Search',
      nc: 1,
    });
    expect(header).toContain(`realm="${c.realm}"`);
    expect(header).toContain(`nonce="${c.nonce}"`);
  });
});

// ---------------------------------------------------------------------------
// Geofence — ràng buộc bắt buộc trước khi chấp nhận quẹt thẻ từ điện thoại
// ---------------------------------------------------------------------------

describe('Thiết bị di động — GPS geofencing chặn quẹt ngoài bán kính', () => {
  const HQ = { lat: 10.776889, lng: 106.700806 };
  const fence = { center: HQ, radiusM: 200 };

  it('Haversine cho khoảng cách hợp lý ở toạ độ TP.HCM', () => {
    const d = haversineDistanceM(HQ, { lat: 10.7769, lng: 106.7009 });
    expect(d).toBeLessThan(50);
    expect(d).toBeGreaterThan(1);
  });

  it('quẹt trong bán kính được chấp nhận', () => {
    const r = validateGpsPunch({ lat: 10.7769, lng: 106.7009, accuracyM: 12 }, fence);
    expect(r.ok).toBe(true);
    expect(r.distanceM).toBeLessThan(200);
  });

  it('quẹt cách ~1km bị CHẶN tuyệt đối', () => {
    const r = validateGpsPunch({ lat: 10.7859, lng: 106.7008, accuracyM: 12 }, fence);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('OUTSIDE_HARD_RADIUS');
  });

  it('GPS kém chính xác (accuracy 200m) bị từ chối — không thể xác minh', () => {
    const r = validateGpsPunch({ lat: 10.7769, lng: 106.7009, accuracyM: 200 }, fence);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('ACCURACY_TOO_LOW');
  });

  it('mock location bị chặn', () => {
    const r = validateGpsPunch(
      { lat: 10.7769, lng: 106.7009, accuracyM: 10, isMockLocation: true },
      fence,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('MOCK_LOCATION');
  });

  it('thiếu toạ độ bị chặn', () => {
    expect(validateGpsPunch(null, fence).reasons).toContain('MISSING_COORDINATES');
    expect(validateGpsPunch(undefined, fence).ok).toBe(false);
  });

  it('bật đối soát WiFi: sai BSSID thì CHẶN', () => {
    const f = { center: HQ, radiusM: 200, allowedBssids: ['aa:bb:cc:dd:ee:01'] };
    const cfg = { requireWifiBssid: true };
    const bad = validateGpsPunch({ lat: 10.7769, lng: 106.7009, accuracyM: 10, bssid: '11:22:33:44:55:66' }, f, cfg);
    expect(bad.ok).toBe(false);
    expect(bad.reasons).toContain('BSSID_MISMATCH');
    expect(validateGpsPunch({ lat: 10.7769, lng: 106.7009, accuracyM: 10, bssid: 'aa:bb:cc:dd:ee:01' }, f, cfg).ok)
      .toBe(true);
  });

  it('bật đối soát WiFi mà app không thu được BSSID thì CHẶN', () => {
    const f = { center: HQ, radiusM: 200, allowedBssids: ['aa:bb:cc:dd:ee:01'] };
    const r = validateGpsPunch({ lat: 10.7769, lng: 106.7009, accuracyM: 10 }, f, { requireWifiBssid: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('MISSING_BSSID');
  });

  it('KHÔNG bật đối soát WiFi: sai BSSID chỉ cảnh báo, không chặn', () => {
    const f = { center: HQ, radiusM: 200, allowedBssids: ['aa:bb:cc:dd:ee:01'] };
    const r = validateGpsPunch({ lat: 10.7769, lng: 106.7009, accuracyM: 10, bssid: '11:22:33:44:55:66' }, f);
    expect(r.ok).toBe(true);
    expect(r.trusted).toBe(false); // vẫn đánh dấu nghi vấn để HR rà soát
    expect(r.bssidMatched).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/WiFi/);
  });

  it('BSSID khớp cả định dạng dấu gạch ngang lẫn hai chấm', () => {
    expect(normalizeBssid('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeBssid('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeBssid('  AA:BB:CC:DD:EE:FF  ')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeBssid('không-phải-mac')).toBeNull();
  });

  it('polygon hàng rào toà nhà: trong thì ok, ngoài thì chặn', () => {
    const polygon = [
      { lat: 10.7765, lng: 106.7004 },
      { lat: 10.7773, lng: 106.7004 },
      { lat: 10.7773, lng: 106.7012 },
      { lat: 10.7765, lng: 106.7012 },
      { lat: 10.7765, lng: 106.7004 }, // đóng vòng
    ];
    expect(pointInPolygon(HQ, polygon)).toBe(true);
    const outside = validateGpsPunch({ lat: 10.7790, lng: 106.7008, accuracyM: 10 }, { polygon });
    expect(outside.ok).toBe(false);
    expect(outside.reasons).toContain('OUTSIDE_POLYGON');
  });
});
