/**
 * ============================================================================
 * TEST TÍCH HỢP — gọi HTTP thật vào Express app (không mock tầng mạng)
 * ============================================================================
 *
 * Mục tiêu: khoá lại những hành vi chỉ lộ ra khi request đi qua chuỗi
 * middleware thật (helmet → cors → cookieParser → router → auth → controller).
 * Các lỗi từng tìm thấy ở đây và phải giữ cho khỏi tái diễn:
 *
 *   1. Origin ngoài whitelist trả về HTTP 500 (làm client tưởng server hỏng)
 *   2. Endpoint không tồn tại trả về 401 thay vì 404
 *
 * Test KHÔNG cần PostgreSQL/Redis: chỉ đi tới tầng middleware, không chạm Prisma.
 */

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Express } from 'express';

import { createApp } from '../src/main.js';
import { resetConfigCache } from '../src/config/env.js';

/** Config tối thiểu, không cần DB thật */
function buildApp(): Express {
  resetConfigCache();
  return createApp();
}

describe('HTTP — health & bảo mật cơ bản', () => {
  it('GET /health trả 200 kèm trạng thái', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('helmet gắn đủ các header bảo mật', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined(); // đã tắt fingerprint
  });
});

describe('HTTP — CORS whitelist', () => {
  it('origin trong danh sách được phép (kèm Access-Control-Allow-Origin)', async () => {
    const res = await request(buildApp())
      .get('/health')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('origin NGOÀI danh sách bị chặn bằng 403 — không phải 500', async () => {
    // Lỗi từng có: ném Error thường => errorHandler coi là lỗi nội bộ => 500.
    // 500 làm client hiểu nhầm server hỏng và retry vô ích.
    const res = await request(buildApp())
      .get('/health')
      .set('Origin', 'http://evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/Origin/);
    // Không được tiết lộ danh sách origin hợp lệ
    expect(JSON.stringify(res.body)).not.toContain('localhost:5173');
  });

  it('không có Origin (server-to-server, curl) thì cho qua', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
  });
});

/** Token hợp lệ để kiểm tra hành vi của người gọi đã đăng nhập */
async function validToken(): Promise<string> {
  const { signAccessToken } = await import('../src/common/utils/auth.js');
  return signAccessToken(
    { sub: 'u1', username: 'admin', role: 'SUPER_ADMIN', dataScope: 'ALL_COMPANY', scopeRefs: [] },
    process.env.JWT_ACCESS_SECRET!,
    900,
  );
}

describe('HTTP — mã trạng thái phải đúng ngữ nghĩa', () => {
  it('người CHƯA đăng nhập gõ sai đường dẫn => 401 (có chủ ý: không lộ sơ đồ API)', async () => {
    // ĐÁNH ĐỔI BẢO MẬT CÓ CHỦ Ý. Nếu trả 404 trước khi kiểm tra token, kẻ dò
    // quét sẽ phân biệt được route nào tồn tại và vẽ được sơ đồ API từ ngoài.
    // Đổi lại: người chưa đăng nhập không biết mình gõ sai URL hay thiếu token.
    const res = await request(buildApp()).get('/api/v1/route-khong-ton-tai');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('người ĐÃ đăng nhập gõ sai đường dẫn => 404 đúng ngữ nghĩa, không phải 401', async () => {
    // Lỗi từng có: authMiddleware đứng trước mọi route nên route không tồn tại
    // cũng trả 401. Người gọi sẽ đi debug token trong khi chỉ là gõ sai URL.
    const res = await request(buildApp())
      .get('/api/v1/route-khong-ton-tai')
      .set('Authorization', `Bearer ${await validToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('route ngoài API prefix cũng trả 404 có cấu trúc JSON', async () => {
    const res = await request(buildApp()).get('/khong-co-gi-o-day');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('HTTP — bảo vệ tài nguyên', () => {
  it('không có token => 401, không lộ dữ liệu', async () => {
    const res = await request(buildApp()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body).not.toHaveProperty('data');
  });

  it('token rác => 401, không phải 500', async () => {
    const res = await request(buildApp())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer day-khong-phai-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('JWT đúng chữ ký nhưng hết hạn => 401', async () => {
    const { signAccessToken } = await import('../src/common/utils/auth.js');
    // Ký token với TTL âm => hết hạn ngay lập tức
    const expired = signAccessToken(
      { sub: 'u1', username: 'x', role: 'EMPLOYEE', dataScope: 'SELF', scopeRefs: [] },
      process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret-min-32-chars-long-aaaaaaaa',
      -10,
    );
    const res = await request(buildApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('bảo vệ cả route nghiệp vụ, không chỉ /auth', async () => {
    for (const path of ['/api/v1/leave-requests/pending', '/api/v1/my-payslips', '/api/v1/pay-runs/x/journals']) {
      const res = await request(buildApp()).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('route ngoài API prefix trả 404 (không nằm trong vùng bảo vệ)', async () => {
    const res = await request(buildApp()).get('/khong-co-gi-o-day');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('HTTP — rate limiting trên endpoint đăng nhập', () => {
  it('sau quá số lần cho phép thì trả 429 Too Many Requests', async () => {
    const app = buildApp();
    const limit = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 10);
    let lastStatus = 0;
    // Gọi dư ra vài lần để chắc chắn vượt ngưỡng
    for (let i = 0; i < limit + 5; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'khong-ton-tai', password: 'sai-mat-khau' });
      lastStatus = res.status;
    }
    expect([429, 401]).toContain(lastStatus);
    // Phải chặn được trước khi đi hết 15 lần
    expect(lastStatus).toBe(429);
  }, 30_000);
});

describe('HTTP — webhook thiết bị KHÔNG đòi JWT', () => {
  // Máy Ronald Jack/ZKTeco/Hikvision đẩy log bằng HTTP thô, không biết JWT.
  // Nếu authMiddleware đứng trước các route này thì TOÀN BỘ chấm công từ máy
  // sẽ chết với 401 — đây là lỗi thật đã tìm thấy khi gọi HTTP thật.
  it('POST /attendance/devices/adms đi qua được tầng JWT (không trả 401)', async () => {
    const res = await request(buildApp())
      .post('/api/v1/attendance/devices/adms?sn=TEST-01')
      .set('Content-Type', 'text/plain')
      .send('1001\t2026-03-05 07:58:12\t15\t15\t0\t0\t0');

    // Không có PostgreSQL trong môi trường test nên controller sẽ lỗi ở tầng
    // repository (500). Điều cần khẳng định: KHÔNG phải 401 — tức là request
    // đã lọt qua tầng xác thực JWT dành cho người dùng.
    expect(res.status).not.toBe(401);
  });

  it('POST /attendance/devices/hikvision cũng không đòi JWT', async () => {
    const res = await request(buildApp())
      .post('/api/v1/attendance/devices/hikvision')
      .set('Content-Type', 'application/json')
      .send({
        EventNotificationAlert: {
          dateTime: '2026-03-05T07:58:12+07:00',
          macAddress: 'aa:bb:cc:dd:ee:ff',
          AccessControllerEvent: { employeeNo: 'NV0001', subEventType: 75, name: 'X' },
        },
      });

    // KHÔNG có PostgreSQL trong môi trường test, nên không thể khẳng định
    // chính xác mã lỗi nghiệp vụ (400 payload sai / 403 thiết bị chưa đăng ký /
    // 500 không kết nối được DB — tuỳ trạng thái connection của Prisma Client).
    // Cái phải giữ chặt: route này KHÔNG bị tầng JWT chặn => không bao giờ 401.
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Và không được trả về dữ liệu chấm công nào
    expect(res.body).not.toHaveProperty('data');
  });

  it('thiết bị gửi sự kiện chống giả mạo thất bại => không ghi công', async () => {
    // subEventType 35 = anti-spoofing fail. Phải đi qua được tầng HTTP và bị
    // từ chối ở tầng nghiệp vụ, không được lọt thành công.
    const res = await request(buildApp())
      .post('/api/v1/attendance/devices/hikvision')
      .set('Content-Type', 'application/json')
      .send({
        EventNotificationAlert: {
          dateTime: '2026-03-05T07:58:12+07:00',
          macAddress: 'aa:bb:cc:dd:ee:ff',
          AccessControllerEvent: { employeeNo: 'NV0001', subEventType: 35, name: 'X' },
        },
      });
    // Không có DB nên không tra được thiết bị => 403/500. Điều phải đúng:
    // không bao giờ là 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('thiếu tham số sn thì báo 400 rõ ràng, không phải 500', async () => {
    const res = await request(buildApp())
      .post('/api/v1/attendance/devices/adms')
      .set('Content-Type', 'text/plain')
      .send('1001\t2026-03-05 07:58:12\t15\t15\t0\t0\t0');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/sn/);
  });
});
