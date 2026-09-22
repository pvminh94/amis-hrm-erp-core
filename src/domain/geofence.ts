/**
 * ============================================================================
 * ĐỊNH VỊ GPS & GEOFENCING — kiểm tra tính hợp lệ của chấm công di động
 * ============================================================================
 *
 * 1. Khoảng cách đại vòng tròn (great-circle) theo công thức HAVERSINE.
 *    Dùng bán kính Trái Đất trung bình 6.371.008,8 m (IUGG mean radius) —
 *    sai số so với ellipsoid WGS-84 < 0.5% ở quy mô khuôn viên (< 1 km),
 *    hoàn toàn đủ cho geofencing.
 *
 * 2. Điểm-trong-đa-giác (point-in-polygon) bằng thuật toán RAY CASTING
 *    (even-odd rule) cho khuôn viên hình dạng bất kỳ.
 *
 * 3. Đối soát BSSID WiFi văn phòng — chống giả mạo toạ độ bằng mock GPS
 *    (fake GPS app): mock được toạ độ nhưng khó mock đồng thời BSSID.
 *
 * 4. Chặn theo độ chính xác (accuracy) — navigator.geolocation trả về
 *    `accuracy` (bán kính tin cậy 68%, mét). Fix quá "mờ" thì không tin.
 *
 * Hàm THUẦN — dễ kiểm thử, không phụ thuộc navigator/DB.
 */

/** Bán kính Trái Đất trung bình (mét) — IUGG mean radius */
export const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoFence {
  /** Tâm (bắt buộc nếu không có polygon) */
  center?: LatLng;
  /** Bán kính cho phép (mét) */
  radiusM?: number;
  /** Polygon: mảng toạ độ theo GeoJSON ring (điểm đầu = điểm cuối) */
  polygon?: LatLng[];
  /** Danh sách BSSID WiFi hợp lệ (chữ thường) */
  allowedBssids?: string[];
}

export interface GpsFix {
  lat: number;
  lng: number;
  /** Độ chính xác (mét) từ navigator.geolocation */
  accuracyM?: number | null;
  /** BSSID WiFi đang kết nối (từ ứng dụng mobile) */
  bssid?: string | null;
  /** SSID */
  ssid?: string | null;
  /** Độ cao & vận tốc (không bắt buộc) */
  altitudeM?: number | null;
  speedMps?: number | null;
  /** Cờ do hệ điều hành khai báo: vị trí là giả lập */
  isMockLocation?: boolean;
}

export interface GeoValidationConfig {
  /** Từ chối fix có accuracy lớn hơn giá trị này */
  maxAccuracyM: number;
  /** Bán kính cứng — ra ngoài là chặn tuyệt đối */
  hardRadiusM: number;
  /** Bán kính mềm — ra ngoài thì cảnh báo nhưng cho chấm công kèm cờ review */
  softRadiusM?: number;
  /** Bắt buộc phải khớp BSSID */
  requireWifiBssid: boolean;
  /** Có chặn mock location không */
  blockMockLocation: boolean;
  /** Dung sai cộng thêm vào bán kính để bù sai số GPS */
  accuracyToleranceFactor: number;
}

export const DEFAULT_GEO_CONFIG: GeoValidationConfig = {
  maxAccuracyM: 65,
  hardRadiusM: 200,
  softRadiusM: 120,
  requireWifiBssid: false,
  blockMockLocation: true,
  accuracyToleranceFactor: 1,
};

export type GeoRejectReason =
  | 'ACCURACY_TOO_LOW'
  | 'MOCK_LOCATION'
  | 'OUTSIDE_HARD_RADIUS'
  | 'OUTSIDE_POLYGON'
  | 'BSSID_MISMATCH'
  | 'MISSING_COORDINATES'
  | 'MISSING_BSSID';

export interface GeoValidationResult {
  ok: boolean;
  /** true = trong vùng mềm, không cần HR rà soát */
  trusted: boolean;
  distanceM: number | null;
  insidePolygon: boolean | null;
  bssidMatched: boolean | null;
  reasons: GeoRejectReason[];
  warnings: string[];
  /** Bán kính hiệu dụng đã áp dụng (kèm dung sai accuracy) */
  effectiveRadiusM: number;
  /** Chi tiết để ghi audit */
  detail: {
    fenceCenterUsed: LatLng | null;
    polygonVertexCount: number;
    accuracyM: number | null;
    bssid: string | null;
  };
}

// ---------------------------------------------------------------------------
// HAVERSINE
// ---------------------------------------------------------------------------

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Khoảng cách đại vòng tròn giữa 2 điểm toạ độ (mét) — công thức Haversine.
 *
 *   a = sin²(Δφ/2) + cosφ₁·cosφ₂·sin²(Δλ/2)
 *   c = 2·atan2(√a, √(1−a))
 *   d = R·c
 *
 * Ổn định số học hơn công thức law-of-cosines khi khoảng cách nhỏ.
 */
export function haversineDistanceM(a: LatLng, b: LatLng): number {
  if (!isValidLatLng(a) || !isValidLatLng(b)) {
    throw new Error(
      `Toạ độ không hợp lệ: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
    );
  }
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dPhi = toRad(b.lat - a.lat);
  const dLambda = toRad(b.lng - a.lng);

  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  // Kẹp để tránh NaN do sai số dấu phẩy động khi 2 điểm trùng nhau
  const c = 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, h))), Math.sqrt(1 - Math.min(1, Math.max(0, h))));
  return EARTH_RADIUS_M * c;
}

/** Khoảng cách xấp xỉ phẳng (equirectangular) — nhanh, dùng cho pre-filter */
export function approximateDistanceM(a: LatLng, b: LatLng): number {
  const x = toRad(b.lng - a.lng) * Math.cos(toRad((a.lat + b.lat) / 2));
  const y = toRad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

export function isValidLatLng(p: LatLng | null | undefined): p is LatLng {
  if (!p) return false;
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

// ---------------------------------------------------------------------------
// POINT IN POLYGON (RAY CASTING)
// ---------------------------------------------------------------------------

/**
 * Kiểm tra điểm nằm trong đa giác bằng thuật toán ray casting (even-odd).
 * Đa giác được coi là tự động đóng (không cần lặp lại điểm đầu).
 * Điểm nằm đúng trên biên được coi là TRONG (có lợi cho người lao động).
 */
export function pointInPolygon(point: LatLng, polygon: readonly LatLng[]): boolean {
  if (!polygon || polygon.length < 3) {
    throw new Error('Polygon phải có ít nhất 3 đỉnh');
  }
  if (!isValidLatLng(point)) throw new Error(`Toạ độ điểm không hợp lệ: ${JSON.stringify(point)}`);

  // Loại điểm trùng cuối (GeoJSON ring đóng)
  const ring = polygon.filter(
    (p, i) =>
      !(
        i === polygon.length - 1 &&
        polygon.length > 1 &&
        Math.abs(p.lat - polygon[0]!.lat) < 1e-9 &&
        Math.abs(p.lng - polygon[0]!.lng) < 1e-9
      ),
  );

  const x = point.lng;
  const y = point.lat;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.lng;
    const yi = ring[i]!.lat;
    const xj = ring[j]!.lng;
    const yj = ring[j]!.lat;

    // Điểm nằm đúng trên đỉnh
    if (Math.abs(xi - x) < 1e-12 && Math.abs(yi - y) < 1e-12) return true;

    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Khoảng cách từ điểm tới biên đa giác (mét) — dùng để biết "ra ngoài bao xa".
 * Trả 0 nếu điểm nằm trong.
 */
export function distanceToPolygonEdgeM(point: LatLng, polygon: readonly LatLng[]): number {
  if (pointInPolygon(point, polygon)) return 0;
  let min = Number.POSITIVE_INFINITY;
  const ring = polygon.filter((_, i) => !(i === polygon.length - 1 && polygon.length > 3));
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    min = Math.min(min, distanceToSegmentM(point, a, b));
  }
  return min === Number.POSITIVE_INFINITY ? Number.NaN : min;
}

/** Khoảng cách từ điểm tới đoạn thẳng AB (xấp xỉ phẳng, đủ cho quy mô mét) */
export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  // Quy về toạ độ phẳng địa phương (mét) quanh điểm a
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(toRad(a.lat));
  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;
  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.min(1, Math.max(0, t));
  const dx = px - t * bx;
  const dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// BSSID
// ---------------------------------------------------------------------------

export function normalizeBssid(bssid: string | null | undefined): string | null {
  if (!bssid) return null;
  // Giữ hex + cả hai dạng phân tách (: và -), sau đó quy hết về ':'
  const cleaned = bssid
    .toLowerCase()
    .trim()
    .replace(/[^0-9a-f:-]/g, '')
    .replace(/-/g, ':');
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(cleaned) ? cleaned : null;
}

/**
 * Đối soát BSSID WiFi.
 *
 *   null  = không đánh giá được (không cấu hình allowedBssids, HOẶC ứng dụng
 *           không đọc được BSSID — iOS chặn API này)
 *   true  = khớp một trong danh sách cho phép
 *   false = đọc được BSSID nhưng KHÔNG khớp → nghi vấn giả mạo toạ độ
 *
 * Phân biệt null và false là bắt buộc: "app không đọc được WiFi" (lỗi kỹ thuật)
 * và "đang đứng ở mạng WiFi khác" (nghi gian lận) là hai kết luận khác nhau
 * với HR, không được gộp chung.
 */
export function matchBssid(
  bssid: string | null | undefined,
  allowed: readonly string[] | undefined,
): boolean | null {
  if (!allowed || allowed.length === 0) return null; // không cấu hình => không đánh giá
  const norm = normalizeBssid(bssid);
  if (!norm) return null; // không đọc được / không phải MAC hợp lệ => không kết luận được
  return allowed.some((a) => normalizeBssid(a) === norm);
}

// ---------------------------------------------------------------------------
// HÀM CHÍNH
// ---------------------------------------------------------------------------

/**
 * Kiểm tra một lần chấm công di động có hợp lệ về mặt vị trí hay không.
 */
export function validateGpsPunch(
  fix: GpsFix | null | undefined,
  fence: GeoFence,
  cfg: Partial<GeoValidationConfig> = {},
): GeoValidationResult {
  const c: GeoValidationConfig = { ...DEFAULT_GEO_CONFIG, ...cfg };
  const reasons: GeoRejectReason[] = [];
  const warnings: string[] = [];

  const result: GeoValidationResult = {
    ok: true,
    trusted: false,
    distanceM: null,
    insidePolygon: null,
    bssidMatched: null,
    reasons,
    warnings,
    effectiveRadiusM: c.hardRadiusM,
    detail: {
      fenceCenterUsed: fence.center ?? null,
      polygonVertexCount: fence.polygon?.length ?? 0,
      accuracyM: fix?.accuracyM ?? null,
      bssid: fix?.bssid ?? null,
    },
  };

  // --- 0. Có toạ độ không? ---------------------------------------------------
  if (!fix || !isValidLatLng(fix)) {
    reasons.push('MISSING_COORDINATES');
    result.ok = false;
    return result;
  }

  // --- 1. Mock location ------------------------------------------------------
  if (c.blockMockLocation && fix.isMockLocation) {
    reasons.push('MOCK_LOCATION');
    warnings.push('Hệ điều hành khai báo vị trí giả lập (mock provider)');
  }

  // --- 2. Độ chính xác --------------------------------------------------------
  const accuracy = typeof fix.accuracyM === 'number' && Number.isFinite(fix.accuracyM) ? fix.accuracyM : null;
  if (accuracy !== null && accuracy > c.maxAccuracyM) {
    reasons.push('ACCURACY_TOO_LOW');
    warnings.push(`Độ chính xác GPS ${accuracy}m vượt ngưỡng ${c.maxAccuracyM}m`);
  }

  // --- 3. Polygon (ưu tiên hơn bán kính tròn) --------------------------------
  if (fence.polygon && fence.polygon.length >= 3) {
    const inside = pointInPolygon({ lat: fix.lat, lng: fix.lng }, fence.polygon);
    result.insidePolygon = inside;
    if (!inside) {
      reasons.push('OUTSIDE_POLYGON');
      const d = distanceToPolygonEdgeM({ lat: fix.lat, lng: fix.lng }, fence.polygon);
      result.distanceM = Math.round(d);
      warnings.push(`Ngoài vùng khuôn viên, cách biên ${Math.round(d)}m`);
    } else if (fence.center) {
      result.distanceM = Math.round(haversineDistanceM(fence.center, { lat: fix.lat, lng: fix.lng }));
    }
  } else if (fence.center) {
    // --- 4. Bán kính tròn + dung sai accuracy -------------------------------
    const raw = haversineDistanceM(fence.center, { lat: fix.lat, lng: fix.lng });
    result.distanceM = Math.round(raw);
    const tolerance = (accuracy ?? 0) * c.accuracyToleranceFactor;
    const effective = c.hardRadiusM + tolerance;
    result.effectiveRadiusM = effective;

    if (raw > effective) {
      reasons.push('OUTSIDE_HARD_RADIUS');
      warnings.push(
        `Cách trụ sở ${Math.round(raw)}m > bán kính cho phép ${Math.round(effective)}m (đã cộng dung sai ${Math.round(tolerance)}m)`,
      );
    } else if (c.softRadiusM !== undefined && raw > c.softRadiusM) {
      warnings.push(
        `Trong bán kính cứng nhưng ngoài vùng tin cậy ${c.softRadiusM}m — chuyển HR rà soát`,
      );
    }
  } else {
    warnings.push('Địa điểm làm việc chưa cấu hình geofence — chấp nhận và ghi nhận toạ độ');
  }

  // --- 5. Đối soát WiFi BSSID --------------------------------------------------
  const bssidResult = matchBssid(fix.bssid, fence.allowedBssids);
  result.bssidMatched = bssidResult;
  if (bssidResult === false) {
    if (c.requireWifiBssid) {
      reasons.push('BSSID_MISMATCH');
      warnings.push('Không khớp WiFi văn phòng trong khi cấu hình bắt buộc đối soát');
    } else {
      warnings.push('Không khớp WiFi văn phòng — nghi vấn giả mạo toạ độ, chuyển HR rà soát');
    }
  } else if (bssidResult === null && c.requireWifiBssid) {
    reasons.push('MISSING_BSSID');
    warnings.push('Bắt buộc đối soát WiFi nhưng ứng dụng không thu được BSSID');
  }

  result.ok = reasons.length === 0;
  // "trusted" = hợp lệ, trong vùng tin cậy, và có bằng chứng WiFi (nếu có cấu hình)
  result.trusted =
    result.ok &&
    (result.distanceM === null || result.distanceM <= (c.softRadiusM ?? c.hardRadiusM)) &&
    bssidResult !== false;

  return result;
}
