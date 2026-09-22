/**
 * ============================================================================
 * ACTIVE LIVENESS DETECTION — chống giả mạo nhận diện khuôn mặt
 * ============================================================================
 *
 * Ba hướng tấn công chính khi chấm công bằng FaceID và cách phát hiện:
 *
 *  (A) PRINT ATTACK — in ảnh 2D ra giấy:
 *      Ảnh chụp lại từ giấy có phổ tần số cao bị suy giảm mạnh (giấy hấp thụ
 *      chi tiết) + xuất hiện biên giấy/đường cắt. Đo bằng tỷ lệ năng lượng
 *     高频 trên tổng năng lượng.
 *
 *  (B) SCREEN REPLAY — phát lại video trên màn hình điện thoại/tablet:
 *      Màn hình có cấu trúc lưới pixel cố định => sinh ra vân giao thoa MOIRÉ
 *      ở tần số không gian đặc trưng. Phát hiện bằng biến đổi Fourier 2D
 *      (radix-2 DIT FFT) trên ảnh xám đã resize về 64x64, tìm ĐỈNH PHỔ SẮT
 *      (sharp spectral peak) nằm ngoài vùng DC.
 *
 *  (C) DEPTH / BEHAVIOUR — không có tín hiệu độ sâu, không có chớp mắt,
 *      đầu hoàn toàn bất động, hoặc khoảng cách khuôn mặt bất thường.
 *      Đánh giá bằng các chỉ số hành vi do SDK/ứng dụng cung cấp.
 *
 * Tất cả hàm ở đây là THUẦN và làm việc trên mảng số — có thể chạy unit test
 * đầy đủ mà không cần camera thật. Ảnh đầu vào là mảng xám 8-bit, row-major.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// BIẾN ĐỔI FOURIER 2D (radix-2 DIT FFT) — triển khai thật, không mock
// ---------------------------------------------------------------------------

/** Biến đổi Fourier nhanh 1 chiều, tại chỗ (in-place), radix-2 DIT. */
export function fft1d(real: Float64Array, imag: Float64Array, inverse = false): void {
  const n = real.length;
  if (n === 0) return;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT yêu cầu độ dài luỹ thừa 2, nhận: ${n}`);

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!;
      real[i] = real[j]!;
      real[j] = tr;
      const ti = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = ti;
    }
  }

  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wReal = Math.cos(ang);
    const wImag = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aIdx = i + k;
        const bIdx = i + k + len / 2;
        const uReal = real[aIdx]!;
        const uImag = imag[aIdx]!;
        const vReal = real[bIdx]! * curReal - imag[bIdx]! * curImag;
        const vImag = real[bIdx]! * curImag + imag[bIdx]! * curReal;
        real[aIdx] = uReal + vReal;
        imag[aIdx] = uImag + vImag;
        real[bIdx] = uReal - vReal;
        imag[bIdx] = uImag - vImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      real[i]!/= n;
      imag[i]!/= n;
    }
  }
}

/** FFT 2 chiều (hàng rồi cột). Trả về biên độ phổ. */
export function fft2dMagnitude(gray: Uint8Array | number[], width: number, height: number): Float64Array {
  if (gray.length !== width * height) {
    throw new Error(`Kích thước ảnh không khớp: ${gray.length} != ${width}x${height}`);
  }
  if ((width & (width - 1)) !== 0 || (height & (height - 1)) !== 0) {
    throw new Error('FFT 2D yêu cầu chiều rộng và cao là luỹ thừa 2');
  }

  const real = new Float64Array(width * height);
  const imag = new Float64Array(width * height);
  for (let i = 0; i < gray.length; i += 1) real[i] = gray[i]!;

  // FFT theo hàng
  const rowR = new Float64Array(width);
  const rowI = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rowR[x] = real[y * width + x]!;
      rowI[x] = imag[y * width + x]!;
    }
    fft1d(rowR, rowI);
    for (let x = 0; x < width; x += 1) {
      real[y * width + x] = rowR[x]!;
      imag[y * width + x] = rowI[x]!;
    }
  }
  // FFT theo cột
  const colR = new Float64Array(height);
  const colI = new Float64Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      colR[y] = real[y * width + x]!;
      colI[y] = imag[y * width + x]!;
    }
    fft1d(colR, colI);
    for (let y = 0; y < height; y += 1) {
      real[y * width + x] = colR[y]!;
      imag[y * width + x] = colI[y]!;
    }
  }

  const mag = new Float64Array(width * height);
  for (let i = 0; i < mag.length; i += 1) {
    mag[i] = Math.hypot(real[i]!, imag[i]!);
  }
  return mag;
}

/** Dịch phổ để DC về tâm — thuận tiện cho việc loại bỏ thành phần DC */
export function fftShift(mag: Float64Array, width: number, height: number): Float64Array {
  const out = new Float64Array(mag.length);
  const halfW = width >> 1;
  const halfH = height >> 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ny = (y + halfH) % height;
      const nx = (x + halfW) % width;
      out[ny * width + nx] = mag[y * width + x]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CHỈ SỐ PHÂN TÍCH
// ---------------------------------------------------------------------------

export interface SpectralFeatures {
  /** Tỷ lệ BIÊN ĐỘ cao tần / tổng (loại trừ DC). Chỉ mang tính tham khảo:
   *  vì cộng biên độ (không phải năng lượng) và phổ 2D của ảnh tự nhiên vốn
   *  trải rộng, giá trị này gần 1 với MỌI ảnh — KHÔNG dùng làm ngưỡng quyết định. */
  highFreqRatio: number;
  /** Tỷ lệ NĂNG LƯỢNG (Σ|X|²) trên tần số Nyquist/4, theo định lý Parseval.
   *  Ảnh in 2D bị giấy hấp thụ chi tiết nên giá trị này thấp rõ rệt. */
  highFreqEnergyRatio: number;
  /** Độ sắc nét chuẩn hoá = sqrt(var(Laplacian)) / std(ảnh). Không thứ nguyên,
   *  so sánh được giữa các ảnh khác độ tương phản. Ảnh in/màn hình: < 2. */
  detailSharpness: number;
  /** Tỷ lệ đỉnh phổ sắc nét lớn nhất (so với năng lượng trung bình vùng lân cận).
   *  Giá trị cao => có cấu trúc tuần hoàn = MOIRÉ từ màn hình. */
  moirePeakRatio: number;
  /** Tần số không gian quy chuẩn của đỉnh (0..0.5, Nyquist) */
  moirePeakFreq: number;
  /** Entropy phổ (phổ phẳng => tự nhiên; phổ nhọn => nhân tạo) */
  spectralEntropy: number;
  /** Độ lệch chuẩn ảnh xám */
  contrastStd: number;
  /** Độ sắc nét (phương sai Laplacian) — ảnh in thường mờ hơn */
  laplacianVariance: number;
}

export interface LivenessInput {
  /** Ảnh xám 8-bit, kích thước width x height (khuyến nghị 64x64 hoặc 128x128) */
  gray?: Uint8Array | number[];
  width?: number;
  height?: number;
  // --- Tín hiệu do SDK/thiết bị cung cấp ---
  /** Có tín hiệu độ sâu (structured light / ToF / stereo) */
  hasDepthSignal?: boolean;
  /** Độ sâu trung bình của khuôn mặt (mm). Màn hình phẳng ~ 0. */
  meanDepthMm?: number | null;
  /** Số lần chớp mắt trong cửa sổ quan sát (2-4s) */
  blinkCount?: number;
  /** Biên độ chuyển động đầu (độ). Đầu bất động hoàn toàn là dấu hiệu phát lại. */
  headMotionDeg?: number;
  /** Tỷ lệ khung khuôn mặt so với khung hình (0..1) */
  faceBoundingBoxRatio?: number;
  /** Điểm tương đồng với vector đã đăng ký (0..1) */
  similarity?: number;
  /** Thiết bị có camera IR / active illumination không */
  hasIrCamera?: boolean;
}

export interface LivenessResult {
  /** true = người thật */
  isLive: boolean;
  /** Điểm tổng hợp 0..1, >= ngưỡng thì chấp nhận */
  confidence: number;
  /** Loại tấn công nghi ngờ, null nếu không */
  suspectedAttack: 'PRINT_2D' | 'SCREEN_REPLAY' | 'STATIC_REPLAY' | 'NO_FACE' | null;
  features: Partial<SpectralFeatures> & {
    blinkOk: boolean | null;
    motionOk: boolean | null;
    depthOk: boolean | null;
  };
  reasons: string[];
  /** Điểm thành phần để audit */
  scores: Record<string, number>;
}

export interface LivenessConfig {
  /** Ngưỡng chấp nhận */
  minConfidence: number;
  /** Đỉnh Moiré vượt tỷ lệ này => nghi màn hình */
  moirePeakThreshold: number;
  /** Dải tần số KHÔNG GIAN hợp lệ của vân Moiré (phần của Nyquist).
   *  Màn hình có chu kỳ pixel ~2–10px; đỉnh nằm ngoài dải này là gradient
   *  của chính bức ảnh chứ không phải Moiré. */
  moireFreqBand: [number, number];
  /** detailSharpness dưới ngưỡng này => nghi ảnh in 2D / bề mặt phẳng */
  minDetailSharpness: number;
  /** (tham khảo) ngưỡng tỷ lệ biên độ cao tần */
  minHighFreqRatio: number;
  /** Số lần chớp mắt tối thiểu */
  minBlinks: number;
  /** Chuyển động đầu tối thiểu (độ) */
  minHeadMotionDeg: number;
  /** Độ sâu tối thiểu để coi là có khối (mm) */
  minMeanDepthMm: number;
  /** Trọng số các thành phần điểm */
  weights: {
    spectral: number;
    moire: number;
    blink: number;
    motion: number;
    depth: number;
    similarity: number;
  };
  /** Ngưỡng tương đồng tối thiểu với vector đăng ký */
  minSimilarity: number;
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  minConfidence: 0.62,
  moirePeakThreshold: 8,
  moireFreqBand: [0.08, 0.48],
  minDetailSharpness: 2.5,
  minHighFreqRatio: 0.12,
  minBlinks: 1,
  minHeadMotionDeg: 1.5,
  minMeanDepthMm: 12,
  weights: { spectral: 0.2, moire: 0.25, blink: 0.12, motion: 0.13, depth: 0.15, similarity: 0.15 },
  minSimilarity: 0.42,
};

// ---------------------------------------------------------------------------
// TRÍCH XUẬT ĐẶC TRƯNG PHỔ
// ---------------------------------------------------------------------------

/**
 * Trích đặc trưng phổ từ ảnh xám.
 *
 * MOIRÉ: tìm biên độ lớn nhất ngoài vùng DC (bán kính dcRadius) và so với
 * năng lượng trung bình của vành khuyên quanh nó. Màn hình phát lại video
 * tạo ra một vài đỉnh rất nhọn => tỷ lệ này lớn.
 */
export function extractSpectralFeatures(
  gray: Uint8Array | number[],
  width: number,
  height: number,
  opts: { dcRadius?: number } = {},
): SpectralFeatures {
  const dcRadius = opts.dcRadius ?? 2;
  const mag = fftShift(fft2dMagnitude(gray, width, height), width, height);
  const cx = width >> 1;
  const cy = height >> 1;

  let total = 0;
  let lowBand = 0;
  let highBand = 0;
  let energyTotal = 0;
  let energyHigh = 0;
  let peak = 0;
  let peakX = cx;
  let peakY = cy;
  let peakR = 0;
  let ringSum = 0;
  let ringCount = 0;

  const nyquist = Math.min(width, height) / 2;
  // Ranh giới thấp/cao tần: 1/4 tần số Nyquist
  const cutoff = nyquist / 4;

  // Vùng vành khuyên để so sánh đỉnh (bán kính 3..8)
  // Vành khuyên khảo sát PHẢI phủ tới gần tần số Nyquist: vân Moiré do lưới
  // pixel màn hình nằm ở tần số không gian CAO (chu kỳ 2–8 px). Nếu chỉ quét
  // tới Nyquist/2 thì BỎ SÓT hoàn toàn đỉnh Moiré → không phát hiện được
  // tấn công phát lại qua màn hình.
  const ringInner = 3;
  const ringOuter = Math.max(4, Math.floor(nyquist) - 1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = mag[y * width + x]!;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r <= dcRadius) continue; // bỏ DC
      total += v;
      energyTotal += v * v;
      if (r <= cutoff) lowBand += v;
      else {
        highBand += v;
        energyHigh += v * v;
      }

      if (r >= ringInner && r <= ringOuter) {
        ringSum += v;
        ringCount += 1;
        if (v > peak) {
          peak = v;
          peakX = x;
          peakY = y;
          peakR = r;
        }
      }
    }
  }

  const meanRing = ringCount > 0 ? ringSum / ringCount : 0;
  const moirePeakRatio = meanRing > 0 ? peak / meanRing : 0;

  // Entropy phổ chuẩn hoá
  let entropy = 0;
  if (total > 0) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if (Math.sqrt(dx * dx + dy * dy) <= dcRadius) continue;
        const p = mag[y * width + x]! / total;
        if (p > 0) entropy -= p * Math.log2(p);
      }
    }
    const maxEntropy = Math.log2(Math.max(1, ringCount || width * height));
    entropy = maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  // Độ lệch chuẩn ảnh xám
  let mean = 0;
  for (let i = 0; i < gray.length; i += 1) mean += gray[i]!;
  mean /= gray.length || 1;
  let variance = 0;
  for (let i = 0; i < gray.length; i += 1) variance += (gray[i]! - mean) ** 2;
  variance /= gray.length || 1;

  const contrastStd = Math.sqrt(variance);
  const lapVar = laplacianVariance(gray, width, height);

  return {
    highFreqRatio: total > 0 ? highBand / total : 0,
    highFreqEnergyRatio: energyTotal > 0 ? energyHigh / energyTotal : 0,
    detailSharpness: contrastStd > 1e-6 ? Math.sqrt(lapVar) / contrastStd : 0,
    moirePeakRatio,
    moirePeakFreq: nyquist > 0 ? peakR / (2 * nyquist) : 0,
    spectralEntropy: entropy,
    contrastStd,
    laplacianVariance: lapVar,
  };
}

/** Phương sai của bộ lọc Laplacian 4-láng giềng — thước đo độ sắc nét */
export function laplacianVariance(gray: Uint8Array | number[], width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  const vals: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const lap =
        4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      vals.push(lap);
    }
  }
  if (vals.length === 0) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// HÀM CHÍNH
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Đánh giá liveness tổng hợp.
 *
 * Điểm = tổng có trọng số của các thành phần. Mỗi thành phần là 0..1:
 *   spectral   : ảnh có chi tiết cao tần đủ (chống ảnh in)
 *   moire      : KHÔNG có đỉnh phổ sắc nét (chống phát lại màn hình)
 *   blink      : có chớp mắt
 *   motion     : có chuyển động đầu tự nhiên
 *   depth      : có khối 3D
 *   similarity : khớp với vector đã đăng ký
 */
export function detectLiveness(
  input: LivenessInput,
  cfg: Partial<LivenessConfig> = {},
): LivenessResult {
  const c: LivenessConfig = { ...DEFAULT_LIVENESS_CONFIG, ...cfg, weights: { ...DEFAULT_LIVENESS_CONFIG.weights, ...(cfg.weights ?? {}) } };
  const reasons: string[] = [];
  const scores: Record<string, number> = {};
  let features: LivenessResult['features'] = { blinkOk: null, motionOk: null, depthOk: null };

  // --- 1. Phân tích phổ (nếu có ảnh) ----------------------------------------
  let spectralScore = 0.5;
  let moireScore = 0.5;
  if (input.gray && input.width && input.height) {
    const f = extractSpectralFeatures(input.gray, input.width, input.height);
    features = {
      ...features,
      highFreqRatio: f.highFreqRatio,
      highFreqEnergyRatio: f.highFreqEnergyRatio,
      detailSharpness: f.detailSharpness,
      moirePeakRatio: f.moirePeakRatio,
      moirePeakFreq: f.moirePeakFreq,
      spectralEntropy: f.spectralEntropy,
      contrastStd: f.contrastStd,
      laplacianVariance: f.laplacianVariance,
    };

    // Điểm "đủ chi tiết" — ảnh in 2D bị giấy hấp thụ chi tiết nên độ sắc nét
    // chuẩn hoá rất thấp. Tuyến tính: 0 tại ngưỡng, 1 tại 2× ngưỡng.
    spectralScore = clamp01(f.detailSharpness / (c.minDetailSharpness * 2));
    if (f.detailSharpness < c.minDetailSharpness) {
      reasons.push(
        `Độ sắc nét chuẩn hoá ${f.detailSharpness.toFixed(2)} < ${c.minDetailSharpness} ` +
          `(năng lượng cao tần ${(f.highFreqEnergyRatio * 100).toFixed(1)}%) — nghi ảnh in 2D`,
      );
    }

    // Điểm "không có vân Moiré" — chỉ xét đỉnh NẰM TRONG dải tần số đặc trưng
    // của lưới pixel màn hình. Đỉnh ở tần số rất thấp là gradient của ảnh.
    const inMoireBand =
      f.moirePeakFreq >= c.moireFreqBand[0] && f.moirePeakFreq <= c.moireFreqBand[1];
    const effectiveMoirePeak = inMoireBand ? f.moirePeakRatio : 1;
    moireScore = clamp01(1 - (effectiveMoirePeak - 1) / (c.moirePeakThreshold - 1));
    if (effectiveMoirePeak >= c.moirePeakThreshold) {
      reasons.push(
        `Đỉnh phổ sắc nét x${f.moirePeakRatio.toFixed(1)} tại tần số ${f.moirePeakFreq.toFixed(3)} ` +
          `(trong dải Moiré ${c.moireFreqBand[0]}–${c.moireFreqBand[1]}) — nghi phát lại qua màn hình`,
      );
    }
    if (f.contrastStd < 8) {
      reasons.push('Ảnh thiếu tương phản — nghi là ảnh chụp lại hoặc vùng tối');
      spectralScore *= 0.5;
    }
  } else {
    reasons.push('Không có dữ liệu ảnh để phân tích phổ — chỉ dựa vào tín hiệu hành vi');
  }

  // --- 2. Chớp mắt ------------------------------------------------------------
  if (typeof input.blinkCount === 'number') {
    features.blinkOk = input.blinkCount >= c.minBlinks;
    scores.blink = features.blinkOk ? 1 : 0;
    if (!features.blinkOk) reasons.push(`Không phát hiện chớp mắt (cần ≥ ${c.minBlinks} lần)`);
  }

  // --- 3. Chuyển động đầu -------------------------------------------------------
  if (typeof input.headMotionDeg === 'number') {
    features.motionOk = input.headMotionDeg >= c.minHeadMotionDeg;
    scores.motion = clamp01(input.headMotionDeg / (c.minHeadMotionDeg * 2));
    if (!features.motionOk) {
      reasons.push(`Đầu gần như bất động (${input.headMotionDeg.toFixed(2)}°) — nghi phát lại video tĩnh`);
    }
  }

  // --- 4. Độ sâu ------------------------------------------------------------------
  if (input.hasDepthSignal && typeof input.meanDepthMm === 'number') {
    features.depthOk = input.meanDepthMm >= c.minMeanDepthMm;
    scores.depth = clamp01(input.meanDepthMm / (c.minMeanDepthMm * 3));
    if (!features.depthOk) {
      reasons.push(`Độ sâu khuôn mặt ${input.meanDepthMm}mm — bề mặt phẳng, nghi ảnh/màn hình`);
    }
  }

  // --- 5. Tương đồng với vector đã đăng ký -----------------------------------------
  if (typeof input.similarity === 'number') {
    scores.similarity = clamp01(input.similarity / Math.max(0.0001, c.minSimilarity * 1.5));
    if (input.similarity < c.minSimilarity) {
      reasons.push(`Điểm tương đồng ${(input.similarity * 100).toFixed(1)}% < ngưỡng ${(c.minSimilarity * 100).toFixed(0)}%`);
    }
  }

  scores.spectral = spectralScore;
  scores.moire = moireScore;
  if (scores.blink === undefined) scores.blink = 0.5;
  if (scores.motion === undefined) scores.motion = 0.5;
  if (scores.depth === undefined) scores.depth = input.hasIrCamera ? 0.6 : 0.4;
  if (scores.similarity === undefined) scores.similarity = 0.5;

  const w = c.weights;
  const totalWeight = w.spectral + w.moire + w.blink + w.motion + w.depth + w.similarity;
  const confidence =
    totalWeight > 0
      ? (scores.spectral! * w.spectral +
          scores.moire! * w.moire +
          scores.blink! * w.blink +
          scores.motion! * w.motion +
          scores.depth! * w.depth +
          scores.similarity! * w.similarity) /
        totalWeight
      : 0;

  // --- Xác định loại tấn công nghi ngờ -------------------------------------------
  // Thứ tự ưu tiên chẩn đoán QUAN TRỌNG: ảnh in 2D bị mờ nên phổ của nó gần
  // như phẳng — một "đỉnh nhọn" trong phổ phẳng chỉ là nhiễu, KHÔNG phải vân
  // Moiré thật. Phải loại trừ PRINT_2D TRƯỚC, nếu không sẽ chẩn đoán nhầm
  // SCREEN_REPLAY cho một tờ giấy.
  let suspectedAttack: LivenessResult['suspectedAttack'] = null;
  const moireInBand =
    features.moirePeakRatio !== undefined &&
    features.moirePeakFreq !== undefined &&
    features.moirePeakFreq >= c.moireFreqBand[0] &&
    features.moirePeakFreq <= c.moireFreqBand[1] &&
    features.moirePeakRatio >= c.moirePeakThreshold;
  if (features.detailSharpness !== undefined && features.detailSharpness < c.minDetailSharpness) {
    suspectedAttack = 'PRINT_2D';
  } else if (moireInBand) {
    suspectedAttack = 'SCREEN_REPLAY';
  } else if (features.motionOk === false && features.blinkOk === false) {
    suspectedAttack = 'STATIC_REPLAY';
  } else if (typeof input.faceBoundingBoxRatio === 'number' && input.faceBoundingBoxRatio < 0.05) {
    suspectedAttack = 'NO_FACE';
  }

  const isLive = confidence >= c.minConfidence && suspectedAttack === null;

  return {
    isLive,
    confidence: Number(confidence.toFixed(4)),
    suspectedAttack,
    features,
    reasons,
    scores,
  };
}

/**
 * Sinh ảnh xám mô phỏng để kiểm thử:
 *  - 'natural' : nhiễu + gradient tự nhiên (phổ trải đều)
 *  - 'moire'   : thêm lưới tuần hoàn tần số cao (giả lập chụp màn hình)
 *  - 'print'   : ảnh mờ, ít chi tiết cao tần (giả lập chụp ảnh in)
 */
export function synthTestImage(
  kind: 'natural' | 'moire' | 'print' | 'flat',
  size = 64,
  seed = 42,
): Uint8Array {
  const img = new Uint8Array(size * size);
  // LCG đơn giản để kết quả tái lập được
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let v = 128 + (x - size / 2) * 0.6 + (y - size / 2) * 0.3;
      if (kind === 'natural' || kind === 'moire') v += (rnd() - 0.5) * 90;
      if (kind === 'print') v += (rnd() - 0.5) * 12;
      if (kind === 'moire') {
        // Lưới pixel màn hình: chu kỳ ~4px => tần số 0.25 Nyquist
        v += 45 * Math.sin((2 * Math.PI * x) / 4) * Math.sin((2 * Math.PI * y) / 4);
      }
      img[y * size + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return img;
}
