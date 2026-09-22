/**
 * Kiểm thử GEOfencing (Haversine, point-in-polygon, BSSID) và LIVENESS (FFT/Moiré).
 */
import { describe, expect, it } from 'vitest';

import {
  approximateDistanceM,
  DEFAULT_GEO_CONFIG,
  distanceToPolygonEdgeM,
  distanceToSegmentM,
  haversineDistanceM,
  isValidLatLng,
  matchBssid,
  normalizeBssid,
  pointInPolygon,
  validateGpsPunch,
} from '../src/domain/geofence.js';
import {
  DEFAULT_LIVENESS_CONFIG,
  detectLiveness,
  extractSpectralFeatures,
  fft1d,
  fft2dMagnitude,
  laplacianVariance,
  synthTestImage,
} from '../src/domain/liveness.js';

// Toạ độ trụ sở mẫu: Quận 1, TP.HCM
const HQ = { lat: 10.776889, lng: 106.700806 };

describe('haversineDistanceM — khoảng cách đại vòng tròn', () => {
  it('hai điểm trùng nhau = 0 m', () => {
    expect(haversineDistanceM(HQ, HQ)).toBe(0);
  });

  it('1 độ vĩ tuyến ≈ 111.19 km', () => {
    const d = haversineDistanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('Hà Nội ↔ TP.HCM ≈ 1.140 km (đối chiếu giá trị đã biết)', () => {
    const hanoi = { lat: 21.0285, lng: 105.8542 };
    const d = haversineDistanceM(hanoi, HQ);
    expect(d).toBeGreaterThan(1_100_000);
    expect(d).toBeLessThan(1_180_000);
  });

  it('đối xứng: d(A,B) = d(B,A)', () => {
    const a = { lat: 10.7769, lng: 106.7009 };
    const b = { lat: 10.8231, lng: 106.6297 };
    expect(haversineDistanceM(a, b)).toBeCloseTo(haversineDistanceM(b, a), 6);
  });

  it('xấp xỉ phẳng sai lệch < 1% ở khoảng cách 500 m', () => {
    const near = { lat: HQ.lat + 0.004, lng: HQ.lng + 0.003 };
    const exact = haversineDistanceM(HQ, near);
    const approx = approximateDistanceM(HQ, near);
    expect(Math.abs(exact - approx) / exact).toBeLessThan(0.01);
  });

  it('bắt lỗi toạ độ ngoài phạm vi', () => {
    expect(() => haversineDistanceM({ lat: 91, lng: 0 }, HQ)).toThrow();
    expect(() => haversineDistanceM(HQ, { lat: 0, lng: 181 })).toThrow();
    expect(isValidLatLng({ lat: 10, lng: 106 })).toBe(true);
    expect(isValidLatLng(null)).toBe(false);
    expect(isValidLatLng({ lat: Number.NaN, lng: 106 })).toBe(false);
  });
});

describe('pointInPolygon — ray casting', () => {
  // Khuôn viên hình chữ nhật ~111m × 111m quanh HQ
  const square = [
    { lat: HQ.lat - 0.0005, lng: HQ.lng - 0.0005 },
    { lat: HQ.lat - 0.0005, lng: HQ.lng + 0.0005 },
    { lat: HQ.lat + 0.0005, lng: HQ.lng + 0.0005 },
    { lat: HQ.lat + 0.0005, lng: HQ.lng - 0.0005 },
  ];

  it('điểm ở tâm nằm trong', () => {
    expect(pointInPolygon(HQ, square)).toBe(true);
  });
  it('điểm xa nằm ngoài', () => {
    expect(pointInPolygon({ lat: HQ.lat + 0.01, lng: HQ.lng }, square)).toBe(false);
  });
  it('đa giác đóng (lặp điểm đầu) vẫn đúng', () => {
    expect(pointInPolygon(HQ, [...square, square[0]!])).toBe(true);
  });
  it('đa giác hình L (không lồi) xử lý đúng', () => {
    const lShape = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
      { lat: 1, lng: 1 },
      { lat: 2, lng: 1 },
      { lat: 2, lng: 0 },
    ];
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, lShape)).toBe(true);
    expect(pointInPolygon({ lat: 1.5, lng: 1.5 }, lShape)).toBe(false); // phần khuyết
    expect(pointInPolygon({ lat: 0.5, lng: 1.5 }, lShape)).toBe(true);
  });
  it('bắt lỗi đa giác < 3 đỉnh', () => {
    expect(() => pointInPolygon(HQ, [square[0]!, square[1]!])).toThrow();
  });
  it('khoảng cách tới biên = 0 khi ở trong', () => {
    expect(distanceToPolygonEdgeM(HQ, square)).toBe(0);
  });
  it('khoảng cách tới biên > 0 khi ở ngoài', () => {
    const outside = { lat: HQ.lat + 0.002, lng: HQ.lng };
    const d = distanceToPolygonEdgeM(outside, square);
    // 0.002 − 0.0005 = 0.0015 độ vĩ ≈ 167 m
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(185);
  });
  it('distanceToSegmentM với điểm chiếu ngoài đoạn', () => {
    const d = distanceToSegmentM({ lat: 0, lng: 5 }, { lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(d).toBeGreaterThan(440_000);
    expect(d).toBeLessThan(450_000);
  });
});

describe('validateGpsPunch — kiểm soát chấm công di động', () => {
  const fence = { center: HQ, radiusM: 200, allowedBssids: ['aa:bb:cc:dd:ee:ff'] };

  it('trong bán kính + đúng WiFi → ok và trusted', () => {
    const r = validateGpsPunch(
      { lat: HQ.lat + 0.0002, lng: HQ.lng, accuracyM: 10, bssid: 'AA:BB:CC:DD:EE:FF' },
      fence,
    );
    expect(r.ok).toBe(true);
    expect(r.trusted).toBe(true);
    expect(r.distanceM).toBeLessThan(60);
    expect(r.bssidMatched).toBe(true);
  });

  it('vượt bán kính cứng → chặn', () => {
    const r = validateGpsPunch(
      { lat: HQ.lat + 0.01, lng: HQ.lng, accuracyM: 10 }, // ~1.1 km
      fence,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('OUTSIDE_HARD_RADIUS');
    expect(r.distanceM).toBeGreaterThan(1000);
  });

  it('accuracy quá kém → chặn', () => {
    const r = validateGpsPunch(
      { lat: HQ.lat, lng: HQ.lng, accuracyM: 200 },
      fence,
      { maxAccuracyM: 65 },
    );
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('ACCURACY_TOO_LOW');
  });

  it('mock location → chặn', () => {
    const r = validateGpsPunch(
      { lat: HQ.lat, lng: HQ.lng, accuracyM: 5, isMockLocation: true },
      fence,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('MOCK_LOCATION');
  });

  it('sai BSSID: chỉ cảnh báo khi không bắt buộc, chặn khi bắt buộc', () => {
    const soft = validateGpsPunch(
      { lat: HQ.lat, lng: HQ.lng, accuracyM: 5, bssid: '11:22:33:44:55:66' },
      fence,
      { requireWifiBssid: false },
    );
    expect(soft.ok).toBe(true);
    expect(soft.bssidMatched).toBe(false);
    expect(soft.trusted).toBe(false);

    const hard = validateGpsPunch(
      { lat: HQ.lat, lng: HQ.lng, accuracyM: 5, bssid: '11:22:33:44:55:66' },
      fence,
      { requireWifiBssid: true },
    );
    expect(hard.ok).toBe(false);
    expect(hard.reasons).toContain('BSSID_MISMATCH');
  });

  it('không có toạ độ → chặn MISSING_COORDINATES', () => {
    expect(validateGpsPunch(null, fence).reasons).toContain('MISSING_COORDINATES');
    expect(validateGpsPunch(undefined, fence).ok).toBe(false);
  });

  it('polygon được ưu tiên hơn bán kính tròn', () => {
    const polyFence = {
      center: HQ,
      radiusM: 5000,
      polygon: [
        { lat: HQ.lat - 0.0005, lng: HQ.lng - 0.0005 },
        { lat: HQ.lat - 0.0005, lng: HQ.lng + 0.0005 },
        { lat: HQ.lat + 0.0005, lng: HQ.lng + 0.0005 },
        { lat: HQ.lat + 0.0005, lng: HQ.lng - 0.0005 },
      ],
    };
    const r = validateGpsPunch({ lat: HQ.lat + 0.005, lng: HQ.lng, accuracyM: 5 }, polyFence);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('OUTSIDE_POLYGON');
    expect(r.insidePolygon).toBe(false);
  });

  it('dung sai accuracy cộng vào bán kính cứng', () => {
    // Cách 180m, bán kính cứng 200m, accuracy 30m → effective 230m → hợp lệ
    const r = validateGpsPunch(
      { lat: HQ.lat + 0.00162, lng: HQ.lng, accuracyM: 30 },
      { center: HQ },
      { hardRadiusM: 200, accuracyToleranceFactor: 1 },
    );
    expect(r.effectiveRadiusM).toBe(230);
    expect(r.ok).toBe(true);
  });

  it('cấu hình mặc định hợp lý cho sản xuất', () => {
    expect(DEFAULT_GEO_CONFIG.maxAccuracyM).toBe(65);
    expect(DEFAULT_GEO_CONFIG.hardRadiusM).toBe(200);
    expect(DEFAULT_GEO_CONFIG.blockMockLocation).toBe(true);
  });
});

describe('normalizeBssid / matchBssid', () => {
  it('chuẩn hoá về chữ thường có dấu hai chấm', () => {
    expect(normalizeBssid('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeBssid('AABBCCDDEEFF')).toBeNull(); // thiếu phân tách
    expect(normalizeBssid(null)).toBeNull();
  });
  it('không cấu hình allowed → null (không đánh giá)', () => {
    expect(matchBssid('aa:bb:cc:dd:ee:ff', [])).toBeNull();
    expect(matchBssid('aa:bb:cc:dd:ee:ff', undefined)).toBeNull();
  });
  it('khớp không phân biệt hoa thường', () => {
    expect(matchBssid('AA:BB:CC:DD:EE:FF', ['aa:bb:cc:dd:ee:ff'])).toBe(true);
  });
});

// ===========================================================================
// LIVENESS
// ===========================================================================

describe('FFT — biến đổi Fourier', () => {
  it('FFT của tín hiệu DC chỉ có thành phần DC', () => {
    const n = 8;
    const re = new Float64Array(n).fill(5);
    const im = new Float64Array(n);
    fft1d(re, im);
    expect(re[0]).toBeCloseTo(40, 9);
    for (let i = 1; i < n; i += 1) {
      expect(Math.hypot(re[i]!, im[i]!)).toBeLessThan(1e-9);
    }
  });

  it('FFT rồi IFFT khôi phục tín hiệu gốc', () => {
    const n = 16;
    const orig = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + i);
    const re = Float64Array.from(orig);
    const im = new Float64Array(n);
    fft1d(re, im);
    fft1d(re, im, true);
    for (let i = 0; i < n; i += 1) {
      expect(re[i]).toBeCloseTo(orig[i]!, 9);
      expect(im[i]).toBeLessThan(1e-9);
    }
  });

  it('đỉnh phổ đúng tần số của sin thuần', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) re[i] = Math.sin((2 * Math.PI * 4 * i) / n);
    fft1d(re, im);
    let maxIdx = 0;
    let maxMag = 0;
    for (let i = 1; i < n / 2; i += 1) {
      const m = Math.hypot(re[i]!, im[i]!);
      if (m > maxMag) {
        maxMag = m;
        maxIdx = i;
      }
    }
    expect(maxIdx).toBe(4);
  });

  it('bắt lỗi độ dài không phải luỹ thừa 2', () => {
    expect(() => fft1d(new Float64Array(6), new Float64Array(6))).toThrow();
  });

  it('fft2dMagnitude trả về đúng số phần tử', () => {
    const img = new Uint8Array(64).fill(128);
    const mag = fft2dMagnitude(img, 8, 8);
    expect(mag.length).toBe(64);
  });
});

describe('detectLiveness — chống giả mạo', () => {
  it('ảnh tự nhiên + chớp mắt + chuyển động + độ sâu → LIVE', () => {
    const r = detectLiveness({
      gray: synthTestImage('natural', 64),
      width: 64,
      height: 64,
      blinkCount: 2,
      headMotionDeg: 4,
      hasDepthSignal: true,
      meanDepthMm: 45,
      similarity: 0.72,
    });
    expect(r.isLive).toBe(true);
    expect(r.suspectedAttack).toBeNull();
    expect(r.confidence).toBeGreaterThanOrEqual(DEFAULT_LIVENESS_CONFIG.minConfidence);
  });

  it('PHÁT HIỆN PHÁT LẠI QUA MÀN HÌNH qua đỉnh Moiré', () => {
    const features = extractSpectralFeatures(synthTestImage('moire', 64), 64, 64);
    const natural = extractSpectralFeatures(synthTestImage('natural', 64), 64, 64);
    // Ảnh có lưới tuần hoàn phải có đỉnh phổ sắc nét hơn hẳn ảnh tự nhiên
    expect(features.moirePeakRatio).toBeGreaterThan(natural.moirePeakRatio);

    const r = detectLiveness({
      gray: synthTestImage('moire', 64),
      width: 64,
      height: 64,
      blinkCount: 0,
      headMotionDeg: 0,
      similarity: 0.7,
    });
    expect(r.isLive).toBe(false);
    expect(r.suspectedAttack).toBe('SCREEN_REPLAY');
    expect(r.reasons.some((x) => x.includes('Moiré'))).toBe(true);
  });

  it('PHÁT HIỆN ẢNH IN 2D qua năng lượng cao tần thấp', () => {
    const r = detectLiveness({
      gray: synthTestImage('print', 64),
      width: 64,
      height: 64,
      blinkCount: 0,
      headMotionDeg: 0,
      similarity: 0.7,
    });
    expect(r.isLive).toBe(false);
    expect(r.suspectedAttack).toBe('PRINT_2D');
    expect(r.features.detailSharpness!).toBeLessThan(DEFAULT_LIVENESS_CONFIG.minDetailSharpness);
  });

  it('không chớp mắt + không chuyển động → nghi phát lại video tĩnh', () => {
    const r = detectLiveness({
      gray: synthTestImage('natural', 64),
      width: 64,
      height: 64,
      blinkCount: 0,
      headMotionDeg: 0.1,
      similarity: 0.7,
    });
    expect(r.features.blinkOk).toBe(false);
    expect(r.features.motionOk).toBe(false);
    expect(r.scores.blink).toBe(0);
  });

  it('bề mặt phẳng (độ sâu ~0) → không live', () => {
    const r = detectLiveness({
      gray: synthTestImage('natural', 64),
      width: 64,
      height: 64,
      blinkCount: 2,
      headMotionDeg: 3,
      hasDepthSignal: true,
      meanDepthMm: 1,
      similarity: 0.7,
    });
    expect(r.features.depthOk).toBe(false);
    expect(r.confidence).toBeLessThan(1);
  });

  it('similarity dưới ngưỡng → bị nêu lý do', () => {
    const r = detectLiveness({
      gray: synthTestImage('natural', 64),
      width: 64,
      height: 64,
      blinkCount: 2,
      headMotionDeg: 3,
      similarity: 0.1,
    });
    expect(r.reasons.some((x) => x.includes('tương đồng'))).toBe(true);
  });

  it('synthTestImage tái lập được (cùng seed cùng ảnh)', () => {
    const a = synthTestImage('moire', 32, 7);
    const b = synthTestImage('moire', 32, 7);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('laplacianVariance: ảnh mờ < ảnh sắc nét', () => {
    const print = synthTestImage('print', 32);
    const natural = synthTestImage('natural', 32);
    expect(laplacianVariance(natural, 32, 32)).toBeGreaterThan(laplacianVariance(print, 32, 32));
  });
});
