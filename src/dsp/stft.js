import { getFFT } from './fft.js';

/** Reflect-pad index (numpy/torch "reflect" mode, edge not repeated). */
export function reflect(i, n) {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  const r = ((i % period) + period) % period;
  return r < n ? r : period - r;
}

const windows = new Map();
/** Periodic Hann window (torch.hann_window default). */
export function hann(n) {
  let w = windows.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windows.set(n, w);
  }
  return w;
}

/**
 * Centered STFT with reflect padding (torch.stft(center=True, pad_mode="reflect")).
 * Output layout is bin-major: index = bin * frames + frame, matching model tensors [1, bins, frames].
 * `bins` may be smaller than nFft/2+1 to keep only low bins.
 */
export function stft(signal, nFft = 2048, hop = 512, bins = nFft / 2 + 1) {
  const frames = Math.floor(signal.length / hop) + 1;
  const real = new Float32Array(bins * frames);
  const imag = new Float32Array(bins * frames);
  const fft = getFFT(nFft);
  const win = hann(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const half = nFft / 2;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < nFft; i++) {
      re[i] = signal[reflect(start + i, signal.length)] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) {
      real[k * frames + f] = re[k];
      imag[k * frames + f] = im[k];
    }
  }
  return { real, imag, frames, bins };
}

/**
 * Inverse of stft(): windowed overlap-add normalised by Σw², trimmed to `length` samples.
 * Bins not provided (bins < nFft/2+1) are treated as zero.
 */
export function istft(real, imag, frames, length, nFft = 2048, hop = 512, bins = nFft / 2 + 1) {
  const fft = getFFT(nFft);
  const win = hann(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const total = nFft + hop * (frames - 1);
  const acc = new Float64Array(total);
  const norm = new Float64Array(total);
  const half = nFft / 2;
  const top = Math.min(bins, half + 1);
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    // Hermitian spectrum, conjugated so the forward FFT computes the inverse.
    for (let k = 0; k < top; k++) {
      const r = real[k * frames + f];
      const i = imag[k * frames + f];
      re[k] = r;
      if (k > 0 && k < half) {
        im[k] = -i;
        re[nFft - k] = r;
        im[nFft - k] = i;
      }
    }
    fft.forward(re, im);
    const offset = f * hop;
    for (let i = 0; i < nFft; i++) {
      acc[offset + i] += (re[i] / nFft) * win[i];
      norm[offset + i] += win[i] * win[i];
    }
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = i + half;
    out[i] = j < total && norm[j] > 1e-10 ? acc[j] / norm[j] : 0;
  }
  return out;
}

/** Band-limited resampling with a 64-tap Blackman-windowed sinc polyphase filter. */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(fromRate, toRate);
  const up = toRate / g;
  const down = fromRate / g;
  const taps = 64;
  const halfTaps = taps / 2;
  const cutoff = 0.97 * Math.min(1, toRate / fromRate);
  const bank = new Float32Array(up * taps);
  for (let p = 0; p < up; p++) {
    const frac = p / up;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = t - halfTaps + 1 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const blackman = 0.42 + 0.5 * Math.cos((Math.PI * x) / halfTaps) + 0.08 * Math.cos((2 * Math.PI * x) / halfTaps);
      const v = Math.abs(x) < halfTaps ? cutoff * sinc * blackman : 0;
      bank[p * taps + t] = v;
      sum += v;
    }
    for (let t = 0; t < taps; t++) bank[p * taps + t] /= sum;
  }
  const outLength = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  for (let o = 0; o < outLength; o++) {
    const pos = o * down;
    const base = Math.floor(pos / up);
    const phase = pos % up;
    const coeffs = phase * taps;
    let s = 0;
    for (let t = 0; t < taps; t++) {
      const j = base + t - halfTaps + 1;
      if (j >= 0 && j < input.length) s += input[j] * bank[coeffs + t];
    }
    out[o] = s;
  }
  return out;
}

export function assertFinite(arr, message = '분리된 소리에 오류가 발생했습니다. 다른 파일로 다시 시도해 주세요.') {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new Error(message);
}
