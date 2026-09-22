/**
 * ============================================================================
 * MIDDLEWARE — bảo mật, xác thực, phân quyền, xử lý lỗi
 * ============================================================================
 */

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';

import type { AppConfig } from '../../config/env.js';
import {
  buildScopeWhere,
  hasPermission,
  verifyAccessToken,
  type ScopeContext,
} from '../../common/utils/auth.js';

// ---------------------------------------------------------------------------
// KIỂU MỞ RỘNG
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: ScopeContext & { username: string };
      clientIp: string;
    }
  }
}

// ---------------------------------------------------------------------------
// LỖI
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', msg, details);
  }
  static unauthorized(msg = 'Chưa xác thực hoặc phiên đã hết hạn') {
    return new ApiError(401, 'UNAUTHORIZED', msg);
  }
  static forbidden(msg = 'Bạn không có quyền thực hiện thao tác này', details?: unknown) {
    return new ApiError(403, 'FORBIDDEN', msg, details);
  }
  static notFound(msg = 'Không tìm thấy dữ liệu') {
    return new ApiError(404, 'NOT_FOUND', msg);
  }
  static conflict(msg: string, details?: unknown) {
    return new ApiError(409, 'CONFLICT', msg, details);
  }
  static unprocessable(msg: string, details?: unknown) {
    return new ApiError(422, 'UNPROCESSABLE', msg, details);
  }
}

/** Wrapper cho async handler — không cần try/catch ở từng controller */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(isProduction: boolean): ErrorRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    // Zod validation
    if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown[] }).issues)) {
      const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dữ liệu gửi lên không hợp lệ',
          details: issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);

    // LUÔN log phía server, kể cả production. Trước đây production chỉ ẩn
    // message khỏi client mà không log gì cả — kết quả là một lỗi 500 trên
    // VPS trở nên KHÔNG THỂ chẩn đoán: client thấy "Lỗi hệ thống", còn
    // `docker compose logs app` thì trống trơn.
    // Ẩn lỗi với client là đúng; ẩn lỗi với người vận hành là sai.
    console.error(
      `[AMIS HRM] 500 ${req.method} ${req.originalUrl}`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );

    // Không lộ chi tiết lỗi nội bộ ra client ở production
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: isProduction ? 'Lỗi hệ thống, vui lòng liên hệ quản trị viên' : message,
      },
    });
  };
}

export function notFoundHandler(apiPrefix: string): RequestHandler {
  return (_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `Không tồn tại endpoint. Các API hợp lệ bắt đầu bằng ${apiPrefix}` },
    });
  };
}

// ---------------------------------------------------------------------------
// CLIENT IP
// ---------------------------------------------------------------------------

/** Gắn IP client thật vào req (ưu tiên X-Forwarded-For sau reverse proxy) */
export const clientIpMiddleware: RequestHandler = (req, _res, next) => {
  const xff = req.headers['x-forwarded-for'];
  let ip = '0.0.0.0';
  if (typeof xff === 'string' && xff.trim() !== '') ip = xff.split(',')[0]!.trim();
  else if (Array.isArray(xff) && xff.length > 0) ip = String(xff[0]).split(',')[0]!.trim();
  else if (typeof req.headers['x-real-ip'] === 'string') ip = req.headers['x-real-ip'] as string;
  else if (req.socket.remoteAddress) ip = req.socket.remoteAddress;
  req.clientIp = ip;
  next();
};

// ---------------------------------------------------------------------------
// XÁC THỰC & PHÂN QUYỀN
// ---------------------------------------------------------------------------

export function authMiddleware(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      next(ApiError.unauthorized('Thiếu Authorization: Bearer <token>'));
      return;
    }
    try {
      const payload = verifyAccessToken(header.slice(7), config.JWT_ACCESS_SECRET);
      req.auth = {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
        dataScope: payload.dataScope,
        scopeRefs: payload.scopeRefs ?? [],
        employeeId: payload.employeeId,
      };
      next();
    } catch (e) {
      const msg = e instanceof Error && e.name === 'TokenExpiredError'
        ? 'Access token đã hết hạn — dùng refresh token để lấy token mới'
        : 'Access token không hợp lệ';
      next(ApiError.unauthorized(msg));
    }
  };
}

/** Yêu cầu một trong các quyền cụ thể */
export function requirePermission(...permissions: string[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) {
      next(ApiError.unauthorized());
      return;
    }
    if (!permissions.some((p) => hasPermission(auth.role, p))) {
      next(
        ApiError.forbidden(
          `Vai trò ${auth.role} thiếu quyền: ${permissions.join(' hoặc ')}`,
        ),
      );
      return;
    }
    next();
  };
}

/** Gắn `where` theo phạm vi dữ liệu vào `req.query.__scopeWhere` */
export function applyDataScope(
  opts: { employeeIdField?: string; departmentIdField?: string } = {},
): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(ApiError.unauthorized());
      return;
    }
    (req as Request & { scopeWhere?: Record<string, unknown> }).scopeWhere = buildScopeWhere(
      req.auth,
      opts as { employeeIdField?: never; departmentIdField?: string },
    );
    next();
  };
}

// ---------------------------------------------------------------------------
// RATE LIMITING
// ---------------------------------------------------------------------------

export function buildRateLimiters(config: AppConfig) {
  const common = {
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    standardHeaders: true as const,
    legacyHeaders: false,
    // Chỉ đếm theo IP thật, không đếm theo socket (sau reverse proxy sẽ giống nhau)
    keyGenerator: (req: Request) => req.clientIp ?? req.ip ?? 'unknown',
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút',
        },
      });
    },
  };
  return {
    general: rateLimit({ ...common, max: config.RATE_LIMIT_MAX }),
    // Endpoint đăng nhập / refresh: giới hạn chặt để chống brute-force
    auth: rateLimit({ ...common, max: config.RATE_LIMIT_AUTH_MAX }),
    // Endpoint thiết bị chấm công đẩy log: nới lỏng nhưng vẫn có trần
    device: rateLimit({ ...common, max: Math.max(1000, config.RATE_LIMIT_MAX * 10) }),
  };
}

// ---------------------------------------------------------------------------
// VALIDATE BODY BẰNG ZOD
// ---------------------------------------------------------------------------

export function validateBody<T>(schema: { parse: (v: unknown) => T }): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function validateQuery<T>(schema: { parse: (v: unknown) => T }): RequestHandler {
  return (req, _res, next) => {
    try {
      req.query = schema.parse(req.query) as never;
      next();
    } catch (e) {
      next(e);
    }
  };
}
