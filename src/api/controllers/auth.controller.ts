/**
 * ============================================================================
 * CONTROLLER — Xác thực (login, refresh, logout, me)
 * ============================================================================
 *
 * Refresh token lưu trong HttpOnly cookie (không đọc được bằng JS => chống
 * XSS đánh cắp token). Áp dụng REFRESH TOKEN ROTATION + REUSE DETECTION:
 * mỗi lần refresh, token cũ bị thu hồi và phát hành token mới trong cùng
 * "family". Nếu phát hiện token đã thu hồi được dùng lại => nghi vấn bị đánh
 * cắp => thu hồi TOÀN BỘ family.
 */

import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import { z } from 'zod';

import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../common/utils/auth.js';
import { verifyPassword } from '../../infra/crypto/crypto.js';
import type { AppConfig } from '../../config/env.js';
import { ApiError, asyncHandler, validateBody } from '../middleware/index.js';
import { getPrisma } from '../../infra/repositories/prisma.js';

const loginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(6).max(128),
});

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export function createAuthRouter(config: AppConfig): Router {
  const router = express.Router();

  const issueTokens = async (
    userId: string,
    userAgent: string | undefined,
    ip: string,
    familyId?: string,
  ) => {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { employee: true } });
    if (!user) throw ApiError.unauthorized('Tài khoản không tồn tại');

    const access = signAccessToken(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        dataScope: user.dataScope,
        scopeRefs: user.scopeRefs ?? [],
        employeeId: user.employee?.id,
      },
      config.JWT_ACCESS_SECRET,
      config.JWT_ACCESS_TTL,
    );

    const fam = familyId ?? randomUUID();
    const { token: refresh, tokenHash } = signRefreshToken(
      user.id,
      fam,
      config.JWT_REFRESH_SECRET,
      config.JWT_REFRESH_TTL,
    );
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        familyId: fam,
        userAgent: userAgent?.slice(0, 255),
        ipAddress: ip,
        expiresAt: new Date(Date.now() + config.JWT_REFRESH_TTL * 1000),
      },
    });

    return { accessToken: access, refreshToken: refresh, user };
  };

  const setRefreshCookie = (res: import('express').Response, token: string) => {
    res.cookie(config.REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.REFRESH_COOKIE_SECURE,
      sameSite: 'lax',
      path: `${config.API_PREFIX}/auth`,
      maxAge: config.JWT_REFRESH_TTL * 1000,
    });
  };

  // --- ĐĂNG NHẬP -------------------------------------------------------------
  router.post(
    '/login',
    validateBody(loginSchema),
    asyncHandler(async (req, res) => {
      const { username, password } = req.body as z.infer<typeof loginSchema>;
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { username } });

      if (!user || user.status !== 'ACTIVE') {
        throw ApiError.unauthorized('Sai tên đăng nhập hoặc mật khẩu');
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
        throw ApiError.forbidden(`Tài khoản đang bị khoá, thử lại sau ${mins} phút`);
      }

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        const failed = user.failedLogins + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLogins: failed,
            lockedUntil: failed >= MAX_FAILED_LOGINS
              ? new Date(Date.now() + LOCK_MINUTES * 60_000)
              : null,
          },
        });
        const remain = MAX_FAILED_LOGINS - failed;
        throw ApiError.unauthorized(
          remain > 0
            ? `Sai mật khẩu. Còn ${remain} lần thử trước khi tài khoản bị khoá ${LOCK_MINUTES} phút`
            : `Sai mật khẩu quá ${MAX_FAILED_LOGINS} lần — tài khoản bị khoá ${LOCK_MINUTES} phút`,
        );
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: req.clientIp },
      });

      const issued = await issueTokens(user.id, req.headers['user-agent'], req.clientIp);
      setRefreshCookie(res, issued.refreshToken);
      res.json({
        accessToken: issued.accessToken,
        tokenType: 'Bearer',
        expiresIn: config.JWT_ACCESS_TTL,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          dataScope: user.dataScope,
          employeeId: issued.user.employee?.id ?? null,
          fullName: issued.user.employee?.fullName ?? null,
        },
      });
    }),
  );

  // --- LÀM MỚI TOKEN (HttpOnly cookie) ---------------------------------------
  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const token = (req.cookies?.[config.REFRESH_COOKIE_NAME] ?? '') as string;
      if (!token) throw ApiError.unauthorized('Thiếu refresh token');

      let payload;
      try {
        payload = verifyRefreshToken(token, config.JWT_REFRESH_SECRET);
      } catch {
        throw ApiError.unauthorized('Refresh token không hợp lệ hoặc đã hết hạn');
      }

      const prisma = getPrisma();
      const tokenHash = hashToken(token);
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

      if (!stored) throw ApiError.unauthorized('Refresh token không tồn tại');

      // REUSE DETECTION: token đã bị thu hồi mà vẫn được dùng lại => đánh cắp
      if (stored.revokedAt) {
        await prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId },
          data: { revokedAt: new Date() },
        });
        throw ApiError.unauthorized(
          'Phát hiện refresh token đã bị thu hồi được tái sử dụng — toàn bộ phiên của tài khoản này đã bị đăng xuất',
        );
      }
      if (stored.expiresAt < new Date()) throw ApiError.unauthorized('Refresh token đã hết hạn');

      // Thu hồi token cũ, phát hành token mới cùng family
      const issued = await issueTokens(
        stored.userId,
        req.headers['user-agent'],
        req.clientIp,
        stored.familyId,
      );
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

      setRefreshCookie(res, issued.refreshToken);
      res.json({
        accessToken: issued.accessToken,
        tokenType: 'Bearer',
        expiresIn: config.JWT_ACCESS_TTL,
      });
    }),
  );

  // --- ĐĂNG XUẤT --------------------------------------------------------------
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = (req.cookies?.[config.REFRESH_COOKIE_NAME] ?? '') as string;
      if (token) {
        const prisma = getPrisma();
        await prisma.refreshToken.updateMany({
          where: { tokenHash: hashToken(token) },
          data: { revokedAt: new Date() },
        });
      }
      res.clearCookie(config.REFRESH_COOKIE_NAME, { path: `${config.API_PREFIX}/auth` });
      res.json({ ok: true });
    }),
  );

  // --- THÔNG TIN PHIÊN HIỆN TẠI ------------------------------------------------
  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw ApiError.unauthorized();
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        include: { employee: { include: { department: true, position: true, manager: true } } },
      });
      if (!user) throw ApiError.notFound('Người dùng không tồn tại');
      res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        dataScope: user.dataScope,
        scopeRefs: user.scopeRefs,
        employee: user.employee
          ? {
              id: user.employee.id,
              code: user.employee.code,
              fullName: user.employee.fullName,
              department: user.employee.department?.name ?? null,
              position: user.employee.position?.name ?? null,
              manager: user.employee.manager?.fullName ?? null,
            }
          : null,
      });
    }),
  );

  return router;
}
