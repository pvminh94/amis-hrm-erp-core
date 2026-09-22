/**
 * ============================================================================
 * CONTROLLER — CHẤM CÔNG
 * ============================================================================
 *
 *  POST /devices/adms           : Ronald Jack / ZKTeco đẩy log (ADMS Push)
 *  POST /devices/hikvision      : Hikvision ISAPI HTTP Listening
 *  POST /punches/mobile         : chấm công di động (GPS + FaceID + liveness)
 *  GET  /attendances            : bảng công theo ngày/kỳ (lọc theo data scope)
 *  GET  /attendances/:id        : chi tiết 1 ngày công kèm vết quẹt thẻ
 */

import express, { type Router } from 'express';
import { z } from 'zod';

import { detectLiveness, type LivenessInput } from '../../domain/liveness.js';
import { validateGpsPunch, type GeoFence } from '../../domain/geofence.js';
import {
  admsDedupeHash,
  mapWorkCodeToSource,
  parseAdmsAttendanceBody,
  parseAdmsRegistration,
  buildAdmsResponse,
} from '../../infra/devices/adms.js';
import { parseHikvisionEvent } from '../../infra/devices/hikvision-isapi.js';
import {
  cosineSimilarity,
  decryptFaceVector,
  loadKey,
} from '../../infra/crypto/crypto.js';
import type { AppConfig } from '../../config/env.js';
import { ApiError, asyncHandler, requirePermission, validateBody } from '../middleware/index.js';
import { getPrisma } from '../../infra/repositories/prisma.js';

const mobilePunchSchema = z.object({
  punchAt: z.coerce.date(),
  direction: z.enum(['IN', 'OUT']).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(5000).optional().nullable(),
  bssid: z.string().max(32).optional().nullable(),
  ssid: z.string().max(64).optional().nullable(),
  isMockLocation: z.boolean().optional(),
  /** Vector khuôn mặt 512D (nếu chấm công bằng FaceID) */
  faceVector: z.array(z.number()).length(512).optional(),
  /** Tín hiệu liveness từ SDK mobile */
  liveness: z
    .object({
      blinkCount: z.number().int().min(0).optional(),
      headMotionDeg: z.number().min(0).optional(),
      hasDepthSignal: z.boolean().optional(),
      meanDepthMm: z.number().nullable().optional(),
      faceBoundingBoxRatio: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export function createAttendanceRouter(config: AppConfig): {
  /** Route do THIẾT BỊ gọi — không đi qua JWT */
  deviceRouter: Router;
  /** Route do NGƯỜI DÙNG gọi — phải có JWT */
  router: Router;
} {
  // HAI router dùng chung một mount point /attendance, nhưng tách bạch về
  // xác thực. Thiết bị chấm công KHÔNG THỂ có JWT (máy Ronald Jack/Hikvision
  // chỉ đẩy HTTP thô) nên route của chúng phải đi qua deviceRouter.
  // Gộp chung một router rồi mount hai lần sẽ làm lộ luôn cả route đọc dữ
  // liệu chấm công của nhân viên ra ngoài mà không cần đăng nhập.
  const deviceRouter = express.Router();
  const router = express.Router();

  // ==========================================================================
  // 1. ADMS PUSH — Ronald Jack / ZKTeco
  // ==========================================================================
  deviceRouter.post(
    '/devices/adms',
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const sn = String(req.query.sn ?? '').trim();
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');

      if (!sn) throw ApiError.badRequest('ADMS thiếu tham số sn');

      const device = await prisma.device.findUnique({ where: { serialNumber: sn } });
      if (!device || !device.isActive) {
        throw ApiError.forbidden(`Thiết bị ${sn} chưa đăng ký hoặc đã ngừng hoạt động`);
      }
      if (config.DEVICE_PUSH_TOKEN && device.pushToken && req.query.token !== device.pushToken) {
        throw ApiError.forbidden('Sai token thiết bị');
      }

      await prisma.device.update({ where: { id: device.id }, data: { lastHeartbeat: new Date() } });

      const { records, skipped } = parseAdmsAttendanceBody(body, 7);
      let inserted = 0;
      for (const r of records) {
        const dedupeHash = admsDedupeHash(sn, r.deviceUserId, r.punchAt);
        const employee = await prisma.employee.findFirst({
          where: { code: r.deviceUserId, deletedAt: null },
          select: { id: true },
        });
        try {
          await prisma.rawPunch.create({
            data: {
              employeeId: employee?.id ?? null,
              deviceUserId: r.deviceUserId,
              deviceId: device.id,
              punchAt: r.punchAt,
              source: mapWorkCodeToSource(r.workCode) === 'FACE' ? 'DEVICE_HIKVISION' : 'ADMS_PUSH',
              direction: r.verifyState === 1 ? 'IN' : r.verifyState === 0 ? 'OUT' : null,
              rawPayload: { workCode: r.workCode, verifyState: r.verifyState, raw: r.rawLine },
              dedupeHash,
              isFaceVerified: mapWorkCodeToSource(r.workCode) === 'FACE',
            },
          });
          inserted += 1;
        } catch {
          // trùng dedupeHash — máy gửi lại log, bỏ qua
        }
      }

      // Trả lệnh cho máy. Sau khi nhận đủ log, yêu cầu máy xoá để giảm dung lượng.
      const commands = inserted > 0 ? (['DELETE_ATTLOG'] as const) : ([] as never[]);
      res.type('text/plain').send(buildAdmsResponse(commands as never));
      void skipped;
    }),
  );

  // ==========================================================================
  // 2. HIKVISION ISAPI HTTP LISTENING
  // ==========================================================================
  deviceRouter.post(
    '/devices/hikvision',
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
      const contentType = String(req.headers['content-type'] ?? 'application/json');

      const parsed = parseHikvisionEvent(rawBody, contentType, 7);
      if (!parsed) throw ApiError.badRequest('Không parse được sự kiện Hikvision');

      const device = parsed.macAddress
        ? await prisma.device.findFirst({ where: { serialNumber: parsed.macAddress } })
        : null;
      if (!device || !device.isActive) {
        throw ApiError.forbidden(`Thiết bị ${parsed.macAddress ?? 'không rõ'} chưa đăng ký hoặc đã ngừng hoạt động`);
      }
      // Bắt buộc kiểm tra token như luồng ADMS. Thiếu bước này thì bất kỳ ai
      // biết địa chỉ webhook đều bơm được công khống vào hệ thống.
      if (config.DEVICE_PUSH_TOKEN && device.pushToken) {
        const presented = req.query.token ?? req.headers['x-device-token'];
        if (presented !== device.pushToken) throw ApiError.forbidden('Sai token thiết bị');
      }

      if (!parsed.accepted) {
        // Ghi nhận sự kiện thất bại để đối soát (không tính công)
        res.json({ statusCode: 1, statusString: 'OK', subStatusCode: 'rejected', reason: parsed.rejectReason });
        return;
      }
      if (!parsed.deviceUserId) throw ApiError.badRequest('Sự kiện thiếu employeeNo/cardNo');

      const employee = await prisma.employee.findFirst({
        where: { code: parsed.deviceUserId, deletedAt: null },
        select: { id: true },
      });
      const dedupeHash = admsDedupeHash(device.serialNumber, parsed.deviceUserId, parsed.punchAt);

      try {
        await prisma.rawPunch.create({
          data: {
            employeeId: employee?.id ?? null,
            deviceUserId: parsed.deviceUserId,
            deviceId: device.id,
            punchAt: parsed.punchAt,
            source: 'ISAPI_LISTEN',
            isFaceVerified: true,
            rawPayload: parsed.raw as object,
            dedupeHash,
          },
        });
      } catch {
        // trùng lặp — bỏ qua
      }
      res.json({ statusCode: 1, statusString: 'OK' });
    }),
  );

  // ==========================================================================
  // 3. CHẤM CÔNG DI ĐỘNG — GPS + Geofence + WiFi + FaceID + Liveness
  // ==========================================================================
  deviceRouter.post(
    '/punches/mobile',
    requirePermission('self.attendance', 'attendance.write'),
    validateBody(mobilePunchSchema),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      if (!auth.employeeId && auth.dataScope === 'SELF') {
        throw ApiError.forbidden('Tài khoản chưa gắn với hồ sơ nhân viên');
      }
      const employeeId = auth.employeeId!;
      const dto = req.body as z.infer<typeof mobilePunchSchema>;

      const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        include: { department: true },
      });
      if (!employee) throw ApiError.notFound('Không tìm thấy nhân viên');

      // --- a. Geofence -------------------------------------------------------
      const dept = employee.department;
      const fence: GeoFence = {
        center:
          dept?.latitude !== null && dept?.latitude !== undefined && dept?.longitude !== null && dept?.longitude !== undefined
            ? { lat: Number(dept.latitude), lng: Number(dept.longitude) }
            : undefined,
        radiusM: dept?.geofenceRadiusM ?? config.GEO_HARD_RADIUS_METERS,
        polygon: (dept?.geofencePolygon as unknown as Array<{ lat: number; lng: number }>) ?? undefined,
        allowedBssids: dept?.wifiBssids ?? [],
      };
      const geo = validateGpsPunch(
        {
          lat: dto.latitude,
          lng: dto.longitude,
          accuracyM: dto.accuracyM ?? null,
          bssid: dto.bssid ?? null,
          ssid: dto.ssid ?? null,
          isMockLocation: dto.isMockLocation,
        },
        fence,
        {
          maxAccuracyM: config.GEO_MAX_ACCURACY_METERS,
          hardRadiusM: dept?.geofenceRadiusM ?? config.GEO_HARD_RADIUS_METERS,
          requireWifiBssid: config.GEO_WIFI_BSSID_REQUIRED,
        },
      );
      if (!geo.ok) {
        throw ApiError.forbidden(
          `Không thể chấm công: ${geo.reasons.join(', ')}. ${geo.warnings.join(' | ')}`,
          geo.detail,
        );
      }

      // --- b. FaceID + Liveness ----------------------------------------------
      let similarity: number | null = null;
      let livenessScore: number | null = null;
      let livenessDetail: object | null = null;
      let moirePeakRatio: number | null = null;

      if (dto.faceVector) {
        const key = loadKey(config.DATA_ENCRYPTION_KEY);
        const enrollment = await prisma.biometricEnrollment.findUnique({ where: { employeeId } });
        if (!enrollment || enrollment.revokedAt) {
          throw ApiError.forbidden('Chưa đăng ký khuôn mặt hoặc đã bị thu hồi');
        }
        const stored = decryptFaceVector(Buffer.from(enrollment.faceVectorEnc).toString('base64'), key);
        similarity = cosineSimilarity(Float32Array.from(dto.faceVector), stored);
        if (similarity < 0.42) {
          throw ApiError.forbidden(
            `Khuôn mặt không khớp với dữ liệu đã đăng ký (điểm ${(similarity * 100).toFixed(1)}%)`,
          );
        }

        const livenessInput: LivenessInput = {
          similarity,
          ...(dto.liveness ?? {}),
        };
        const liveness = detectLiveness(livenessInput, {
          minConfidence: config.LIVENESS_MIN_CONFIDENCE,
        });
        livenessScore = liveness.confidence;
        livenessDetail = { reasons: liveness.reasons, scores: liveness.scores, suspectedAttack: liveness.suspectedAttack };
        moirePeakRatio = liveness.features.moirePeakRatio ?? null;
        if (!liveness.isLive) {
          throw ApiError.forbidden(
            `Kiểm tra chống giả mạo thất bại: ${liveness.suspectedAttack ?? 'không đủ tin cậy'}. ${liveness.reasons.join(' | ')}`,
            livenessDetail,
          );
        }
      }

      // --- c. Ghi nhận quẹt ----------------------------------------------------
      const dedupeHash = admsDedupeHash(
        `MOBILE:${employeeId}`,
        employeeId,
        new Date(Math.floor(dto.punchAt.getTime() / 60_000) * 60_000),
      );
      try {
        const punch = await prisma.rawPunch.create({
          data: {
            employeeId,
            punchAt: dto.punchAt,
            direction: dto.direction ?? null,
            source: dto.faceVector ? 'MOBILE_FACE' : 'MOBILE_GPS',
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyM: dto.accuracyM ?? null,
            bssid: dto.bssid ?? null,
            ssid: dto.ssid ?? null,
            geofenceOk: true,
            distanceM: geo.distanceM,
            isFaceVerified: dto.faceVector !== undefined,
            similarity: similarity ?? undefined,
            livenessScore: livenessScore ?? undefined,
            livenessDetail: livenessDetail ?? undefined,
            moirePeakRatio: moirePeakRatio ?? undefined,
            dedupeHash,
            rawPayload: { trusted: geo.trusted, warnings: geo.warnings },
          },
        });
        res.status(201).json({
          id: punch.id,
          punchAt: punch.punchAt,
          distanceM: geo.distanceM,
          trusted: geo.trusted,
          warnings: geo.warnings,
          livenessScore,
        });
      } catch {
        throw ApiError.conflict('Đã có bản ghi chấm công tại thời điểm này', { dedupeHash });
      }
    }),
  );

  // ==========================================================================
  // 4. TRUY VẤN BẢNG CÔNG
  // ==========================================================================
  router.get(
    '/attendances',
    requirePermission('attendance.read', 'self.attendance'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw ApiError.badRequest('Cần tham số from và to dạng YYYY-MM-DD');
      }

      const where: Record<string, unknown> = {
        workDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        deletedAt: null,
      };
      if (auth.dataScope === 'SELF' || !req.query.employeeId) {
        if (auth.dataScope === 'SELF') {
          if (!auth.employeeId) throw ApiError.forbidden('Tài khoản chưa gắn hồ sơ nhân viên');
          where.employeeId = auth.employeeId;
        }
      }
      if (req.query.employeeId && auth.dataScope !== 'SELF') {
        where.employeeId = String(req.query.employeeId);
      }
      if (req.query.status) where.status = String(req.query.status);

      const rows = await prisma.dailyAttendance.findMany({
        where: where as never,
        include: { shift: { select: { code: true, name: true } }, employee: { select: { code: true, fullName: true } } },
        orderBy: { workDate: 'asc' },
        take: Math.min(Number(req.query.limit ?? 500), 5000),
      });
      res.json({ count: rows.length, data: rows });
    }),
  );

  router.get(
    '/attendances/:id',
    requirePermission('attendance.read', 'self.attendance'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const row = await prisma.dailyAttendance.findUnique({
        where: { id: String(req.params.id) },
        include: { punches: true, shift: true, employee: { select: { code: true, fullName: true } } },
      });
      if (!row) throw ApiError.notFound('Không tìm thấy bản ghi chấm công');
      const auth = req.auth!;
      if (auth.dataScope === 'SELF' && row.employeeId !== auth.employeeId) {
        throw ApiError.forbidden('Bạn chỉ xem được dữ liệu chấm công của chính mình');
      }
      res.json(row);
    }),
  );

  return { deviceRouter, router };
}
