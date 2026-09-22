/**
 * ============================================================================
 * ENTRY POINT — HTTP server (Express + Helmet + CORS whitelist + rate limit)
 * ============================================================================
 */

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { loadConfig } from './config/env.js';
import {
  ApiError,
  authMiddleware,
  buildRateLimiters,
  clientIpMiddleware,
  errorHandler,
  notFoundHandler,
} from './api/middleware/index.js';
import { createAuthRouter } from './api/controllers/auth.controller.js';
import { createAttendanceRouter } from './api/controllers/attendance.controller.js';
import { createApprovalRouter } from './api/controllers/approval.controller.js';
import { createPayrollRouter } from './api/controllers/payroll.controller.js';
import { disconnectPrisma } from './infra/repositories/prisma.js';

export function createApp(config = loadConfig()) {
  const app = express();

  // Tin reverse proxy để lấy IP thật và proto đúng (HTTPS)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // --- Bảo mật ---------------------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // CORS WHITELIST — chỉ các origin khai báo trong CORS_ORIGINS
  app.use(
    cors({
      origin(origin, cb) {
        // Request không có Origin (server-to-server, curl) => cho qua
        if (!origin) return cb(null, true);
        if (config.corsOriginList.includes('*')) return cb(null, true);
        if (config.corsOriginList.includes(origin)) return cb(null, true);
        // Phải là 403 có cấu trúc. Ném Error thường sẽ thành HTTP 500,
        // khiến client tưởng server hỏng và retry vô ích.
        return cb(
          ApiError.forbidden('Origin không nằm trong danh sách cho phép', { origin }),
        );
      },
      credentials: true, // cho phép gửi HttpOnly cookie
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.use(morgan(config.isProduction ? 'combined' : 'dev'));
  app.use(clientIpMiddleware);
  app.use(cookieParser());

  // Thiết bị chấm công đẩy body dạng text/plain (ADMS) hoặc raw buffer (Hikvision multipart)
  app.use(`${config.API_PREFIX}/attendance/devices`, express.raw({ type: '*/*', limit: '20mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  const limiters = buildRateLimiters(config);
  app.use(config.API_PREFIX, limiters.general);

  // --- Health check -----------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), env: config.NODE_ENV, time: new Date().toISOString() });
  });

  // --- Routes -----------------------------------------------------------------
  app.use(`${config.API_PREFIX}/auth`, limiters.auth, createAuthRouter(config));

  // === WEBHOOK THIẾT BỊ CHẤM CÔNG =============================================
  // PHẢI nằm NGOÀI router đòi JWT. Máy Ronald Jack/ZKTeco/Hikvision đẩy log
  // bằng HTTP thô — chúng không biết JWT là gì. Nếu để authMiddleware chặn
  // trước, toàn bộ luồng chấm công từ máy sẽ chết với 401.
  // Xác thực ở đây dùng push token của từng thiết bị (lưu trong DB) do
  // controller tự kiểm tra, cộng với rate limit riêng cho luồng này.
  const { deviceRouter, router: attendanceRouter } = createAttendanceRouter(config);
  app.use(`${config.API_PREFIX}/attendance`, limiters.device, deviceRouter);

  // === API CHO NGƯỜI DÙNG (đòi JWT) ============================================
  const protectedRouter = express.Router();
  protectedRouter.use(authMiddleware(config));
  protectedRouter.use('/attendance', attendanceRouter);
  protectedRouter.use('/', createApprovalRouter());
  protectedRouter.use('/', createPayrollRouter());

  // Thứ tự CÓ CHỦ Ý: protectedRouter (kèm auth) đứng TRƯỚC notFoundHandler.
  //   - chưa đăng nhập + đường dẫn bất kỳ => 401
  //   - đã đăng nhập   + đường dẫn lạ     => 404
  // Trả 401 cho người chưa đăng nhập kể cả khi họ gõ sai URL là đánh đổi bảo
  // mật: nếu trả 404 trước, kẻ dò quét sẽ phân biệt được "route này có tồn
  // tại" hay không và vẽ được sơ đồ API từ bên ngoài. Người gọi hợp lệ (đã
  // có token) vẫn nhận 404 đúng ngữ nghĩa để biết mình gõ sai đường dẫn.
  // Ngoại lệ: route ngoài API prefix (/khong-co-gi-o-day) vẫn trả 404 vì nó
  // không nằm trong vùng được bảo vệ.
  app.use(config.API_PREFIX, protectedRouter);

  // Lưới chặn cuối: bắt MỌI request không khớp route nào — cả trong lẫn
  // ngoài API prefix. Thiếu dòng này Express sẽ trả trang 404 HTML mặc định
  // và client JSON vỡ ngay khi parse.
  app.use(notFoundHandler(config.API_PREFIX));
  app.use(errorHandler(config.isProduction));

  return app;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[AMIS HRM] API sẵn sàng tại http://0.0.0.0:${config.PORT}${config.API_PREFIX} (${config.NODE_ENV})`,
    );
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[AMIS HRM] Nhận ${signal} — đang tắt êm...`);
    server.close(async () => {
      await disconnectPrisma();
      process.exit(0);
    });
    // Ép thoát nếu treo quá 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Chỉ chạy khi được thực thi trực tiếp (không chạy khi import trong test)
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isDirectRun) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[AMIS HRM] Khởi động thất bại:', err);
    process.exit(1);
  });
}
