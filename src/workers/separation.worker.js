// Background-music separation: BandIt v2 (music mask) and TIGER-DnR (music stem).
// "dialogue"/"medium" keep only what both models agree is music; "strong" uses BandIt alone.
import { assertFinite, istft, reflect, resample, stft } from '../dsp/stft.js';
import { createRuntime, fetchJSON, fetchVerified, requestGPUAdapter } from '../engine/runtime.js';
import { createTfRnnGPU } from '../engine/tfrnn-webgpu.js';

const SR = 44100;
const progress = (percent, message) => self.postMessage({ type: 'progress', percent, message });
const MODEL_FAIL = '소리 분리 모델을 내려받지 못했습니다. 잠시 후 다시 시도해 주세요.';
const withBackend = (backend, text) => (backend === 'webgpu' ? `GPU 가속으로 ${text}` : text);

function hannSymmetric(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

async function createTfStage(cfg, models, preferGPU) {
  if (preferGPU) {
    try {
      const adapter = await requestGPUAdapter();
      if (adapter) {
        const weights = await fetchVerified(new URL('bandit-tf.bin', models), cfg.files['bandit-tf.bin'].sha256, MODEL_FAIL);
        return await createTfRnnGPU(adapter, weights, cfg);
      }
    } catch {}
  }
  const onnx = await fetchVerified(new URL('bandit-tf.onnx', models), cfg.files['bandit-tf.onnx'].sha256, MODEL_FAIL);
  const rt = await createRuntime(onnx, { preferGPU: false });
  const dims = [1, cfg.bands, cfg.frames, cfg.emb];
  return { backend: 'wasm', run: async (z) => (await rt.run({ z: [z, dims] })).q, release: rt.release };
}

/** BandIt v2 on 48 kHz mono: split → TF-RNN → complex mask, 50%-overlap Hann OLA. */
async function runBandit(signal, baseURL, preferGPU, onProgress) {
  const models = new URL('models/', baseURL);
  const cfg = await fetchJSON(new URL('bandit.json', models), '분리 모델 정보를 가져오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  if (cfg.sampleRate !== 48000 || cfg.nFft !== 2048 || cfg.hopLength !== 512 || cfg.chunkSamples !== 384000 ||
      cfg.frames !== 751 || cfg.bands !== 64 || cfg.emb !== 128 || cfg.hidden !== 256) {
    throw new Error('분리 모델의 설정이 현재 도구와 맞지 않습니다. 새로고침해 주세요.');
  }
  const [splitBytes, maskBytes] = await Promise.all([
    fetchVerified(new URL('bandit-split.onnx', models), cfg.files['bandit-split.onnx'].sha256, MODEL_FAIL),
    fetchVerified(new URL('bandit-mask.onnx', models), cfg.files['bandit-mask.onnx'].sha256, MODEL_FAIL),
  ]);
  const held = [];
  try {
    const split = await createRuntime(splitBytes, { preferGPU });
    held.push(split);
    const mask = await createRuntime(maskBytes, { preferGPU });
    held.push(mask);
    const tf = await createTfStage(cfg, models, preferGPU);
    held.push(tf);

    const { chunkSamples: size, nFft, hopLength: hop, bands, frames, emb } = cfg;
    const step = size / 2;
    const n = signal.length;
    const win = hannSymmetric(size);
    const starts = [];
    for (let s = -size + step; s < n; s += step) starts.push(s);
    const out = new Float32Array(n);
    const weight = new Float32Array(n);
    const chunk = new Float32Array(size);
    const specDims = [1, nFft / 2 + 1, frames];

    for (let c = 0; c < starts.length; c++) {
      onProgress(c / starts.length, tf.backend);
      const start = starts[c];
      const lo = Math.max(0, start);
      const hi = Math.min(n, start + size);
      chunk.fill(0);
      chunk.set(signal.subarray(lo, hi), lo - start);
      const spec = stft(chunk, nFft, hop);
      const { z } = await split.run({ spec_real: [spec.real, specDims], spec_imag: [spec.imag, specDims] });
      if (z.length !== bands * frames * emb) throw new Error('분리 모델의 결과 길이가 맞지 않습니다.');
      const q = await tf.run(z);
      const { mask_real: mr, mask_imag: mi } = await mask.run({ q: [q, [1, bands, frames, emb]] });
      const re = new Float32Array(spec.real.length);
      const im = new Float32Array(spec.imag.length);
      for (let i = 0; i < re.length; i++) {
        re[i] = spec.real[i] * mr[i] - spec.imag[i] * mi[i];
        im[i] = spec.real[i] * mi[i] + spec.imag[i] * mr[i];
      }
      const music = istft(re, im, spec.frames, size, nFft, hop);
      for (let i = lo; i < hi; i++) {
        out[i] += music[i - start] * win[i - start];
        weight[i] += win[i - start];
      }
    }
    for (let i = 0; i < n; i++) out[i] /= Math.max(weight[i], 1e-8);
    assertFinite(out);
    return { music: out, backend: tf.backend };
  } finally {
    for (const r of held) await r.release().catch(() => {});
  }
}

/** TIGER-DnR music stem on 44.1 kHz mono: 12 s windows, 1 s linear crossfades. */
async function runTiger(signal, baseURL, preferGPU, onProgress) {
  const models = new URL('models/', baseURL);
  const cfg = await fetchJSON(new URL('tiger-2pass.json', models), '분리 모델 정보를 가져오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  if (cfg.sampleRate !== SR || cfg.chunkSamples !== 529200 || cfg.nFft !== 2048 || cfg.hopLength !== 512 || !/^[a-f0-9]{64}$/.test(cfg.sha256 || '')) {
    throw new Error('분리 모델의 설정이 현재 도구와 맞지 않습니다. 새로고침해 주세요.');
  }
  const rt = await createRuntime(await fetchVerified(new URL(cfg.file, models), cfg.sha256, MODEL_FAIL), { preferGPU });
  try {
    const size = cfg.chunkSamples;
    const fade = SR;
    const step = size - fade;
    const pad = size - step;
    const n = signal.length;
    const win = new Float32Array(size).fill(1);
    for (let i = 0; i < fade; i++) {
      win[i] = (i + 1) / (fade + 1);
      win[size - 1 - i] = (i + 1) / (fade + 1);
    }
    const count = Math.floor((n + 2 * pad - size) / step) + 2;
    const out = new Float32Array(n);
    const weight = new Float32Array(n);
    const chunk = new Float32Array(size);
    for (let c = 0; c < count; c++) {
      onProgress(c / count, rt.backend);
      const start = c * step - pad;
      const lo = Math.max(0, start);
      const hi = Math.min(n, start + size);
      if (lo >= hi) continue;
      for (let i = 0; i < size; i++) chunk[i] = signal[reflect(start + i, n)];
      const spec = stft(chunk, cfg.nFft, cfg.hopLength);
      const dims = [1, spec.bins, spec.frames];
      const res = await rt.run({ spec_real: [spec.real, dims], spec_imag: [spec.imag, dims] });
      if (res.music_real.length !== spec.real.length) throw new Error('분리 모델의 결과 길이가 맞지 않습니다.');
      const music = istft(res.music_real, res.music_imag, spec.frames, size, cfg.nFft, cfg.hopLength);
      for (let i = lo; i < hi; i++) {
        out[i] += music[i - start] * win[i - start];
        weight[i] += win[i - start];
      }
    }
    for (let i = 0; i < n; i++) out[i] /= Math.max(weight[i], 1e-8);
    assertFinite(out);
    return { music: out, backend: rt.backend, gpuFallback: rt.gpuFallback };
  } finally {
    await rt.release();
  }
}

/**
 * Builds a real-valued TF mask from the model estimates and applies it to each channel.
 * mask = BandIt ratio, or (when TIGER is present) the geometric mean of both ratios,
 * optionally blended back toward BandIt by `blend`.
 */
function applyMusicMask(channels, mono, tigerMusic, banditMusic, blend, nFft = 2048, hop = 512) {
  const n = mono.length;
  const block = 529200;
  const context = 4 * nFft;
  const out = channels.map(() => new Float32Array(n));
  for (let d = 0; d < n; d += block) {
    const lo = Math.max(0, d - context);
    const hi = Math.min(n, d + block + context);
    const end = Math.min(n, d + block);
    const mix = stft(mono.subarray(lo, hi), nFft, hop);
    const tiger = tigerMusic && stft(tigerMusic.subarray(lo, hi), nFft, hop);
    const bandit = stft(banditMusic.subarray(lo, hi), nFft, hop);
    const mask = new Float32Array(mix.real.length);
    for (let i = 0; i < mask.length; i++) {
      const mag = Math.hypot(mix.real[i], mix.imag[i]) + 1e-9;
      const b = Math.min(1, Math.hypot(bandit.real[i], bandit.imag[i]) / mag);
      mask[i] = tiger
        ? (1 - blend) * Math.sqrt(Math.min(1, Math.hypot(tiger.real[i], tiger.imag[i]) / mag) * b) + blend * b
        : b;
    }
    for (let c = 0; c < channels.length; c++) {
      const spec = channels.length === 1 ? mix : stft(channels[c].subarray(lo, hi), nFft, hop);
      const re = new Float32Array(spec.real.length);
      const im = new Float32Array(spec.imag.length);
      for (let i = 0; i < re.length; i++) {
        re[i] = spec.real[i] * mask[i];
        im[i] = spec.imag[i] * mask[i];
      }
      const y = istft(re, im, spec.frames, hi - lo, nFft, hop);
      out[c].set(y.subarray(d - lo, end - lo), d);
    }
  }
  return out;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'separate') return;
  try {
    const { channels, sampleRate, baseURL } = data;
    if (sampleRate !== SR || !Array.isArray(channels) || ![1, 2].includes(channels.length) ||
        !channels[0]?.length || channels.some((c) => c.length !== channels[0].length)) {
      throw new Error('지원하지 않는 오디오 형식입니다.');
    }
    const preferGPU = data.preferGPU !== false;
    const n = channels[0].length;
    const mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;

    progress(0, '배경음 분리 모델을 불러오는 중입니다. 처음에는 다운로드 시간이 필요합니다.');
    const bandit = await runBandit(resample(mono, SR, 48000), baseURL, preferGPU, (t, backend) =>
      progress(2 + (data.strong ? 90 : 48) * t, withBackend(backend, `배경음 후보를 찾는 중 · 첫 번째 모델 ${Math.round(t * 100)}%`)),
    );
    const banditMusic = resample(bandit.music, 48000, SR).subarray(0, n);
    const tiger = data.strong
      ? { backend: bandit.backend, gpuFallback: false, music: null }
      : await runTiger(mono, baseURL, preferGPU, (t, backend) =>
          progress(50 + 42 * t, withBackend(backend, `배경음 후보를 확인하는 중 · 두 번째 모델 ${Math.round(t * 100)}%`)),
        );

    progress(93, data.strong ? '배경음을 지우고 있어요.' : '두 모델이 모두 배경음이라고 본 소리만 지우고 있어요.');
    const music = applyMusicMask(channels, mono, tiger.music, banditMusic, data.medium ? 0.5 : 0);
    const clean = channels.map((ch, c) => Float32Array.from(ch, (v, i) => v - music[c][i]));
    [...music, ...clean].forEach((a) => assertFinite(a));

    const backend = bandit.backend === 'webgpu' || tiger.backend === 'webgpu' ? 'webgpu' : 'wasm';
    progress(100, '배경음 분리가 끝났습니다.');
    self.postMessage(
      {
        type: 'result',
        music,
        clean,
        backend,
        gpuFallback: preferGPU && (bandit.backend !== 'webgpu' || !!tiger.gpuFallback),
        model: data.strong ? 'BandIt v2' : `BandIt v2 × TIGER-DnR agreement${data.medium ? ' + BandIt 50%' : ''}`,
      },
      [...music, ...clean].map((a) => a.buffer),
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || '소리 분리 중 오류가 발생했습니다.' });
  }
};
