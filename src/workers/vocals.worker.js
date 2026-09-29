// Music-video vocals: UVR-MDX-NET-Voc_FT on stereo 44.1 kHz.
import { assertFinite, istft, stft } from '../dsp/stft.js';
import { createRuntime, fetchJSON, fetchVerified } from '../engine/runtime.js';

const SR = 44100;
const progress = (percent, message) => self.postMessage({ type: 'progress', percent, message });

async function loadModel(baseURL, preferGPU) {
  progress(0, '뮤비 보컬 전용 모델을 불러옵니다. 첫 사용에는 약 67MB를 내려받습니다.');
  const models = new URL('models/', baseURL);
  const cfg = await fetchJSON(new URL('vocals.json', models), '보컬 모델 정보를 가져오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  if (cfg.sampleRate !== SR || cfg.nFft !== 7680 || cfg.hopLength !== 1024 || cfg.dimF !== 3072 || cfg.dimT !== 256 ||
      cfg.chunkSamples !== 261120 || cfg.compensate !== 1.021 || !/^[a-f0-9]{64}$/.test(cfg.sha256 || '')) {
    throw new Error('보컬 모델 설정이 맞지 않습니다. 새로고침해 주세요.');
  }
  const bytes = await fetchVerified(
    new URL('uvr-vocals.onnx', models),
    cfg.sha256,
    '보컬 모델을 내려받지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  );
  progress(2, '보컬 분리 엔진을 준비하고 있어요.');
  const runtime = await createRuntime(bytes, {
    preferGPU,
    onFallback: () => progress(3, 'GPU 가속을 사용할 수 없어 기본 방식으로 이어서 처리합니다.'),
  });
  return { cfg, runtime };
}

/** Model input [1, 4, dimF, dimT]: L real, L imag, R real, R imag; lowest bins zeroed. */
function toTensor(stereo, cfg) {
  const { nFft, hopLength, dimF, dimT } = cfg;
  const plane = dimF * dimT;
  const tensor = new Float32Array(4 * plane);
  for (let c = 0; c < 2; c++) {
    const spec = stft(stereo[c], nFft, hopLength, dimF);
    if (spec.frames !== dimT) throw new Error('보컬 분리용 스테레오 오디오 길이가 올바르지 않습니다.');
    tensor.set(spec.real, 2 * c * plane);
    tensor.set(spec.imag, (2 * c + 1) * plane);
  }
  const zeroBins = cfg.zeroLowBins ?? 3;
  for (let p = 0; p < 4; p++) tensor.fill(0, p * plane, p * plane + zeroBins * dimT);
  return tensor;
}

function fromTensor(tensor, length, cfg) {
  const { nFft, hopLength, dimF, dimT } = cfg;
  const plane = dimF * dimT;
  return [0, 1].map((c) =>
    istft(
      tensor.subarray(2 * c * plane, (2 * c + 1) * plane),
      tensor.subarray((2 * c + 1) * plane, (2 * c + 2) * plane),
      dimT, length, nFft, hopLength, dimF,
    ),
  );
}

/** MDX-style chunking: trim margins on both sides, 75% hop, Hann crossfade. */
async function separateVocals(channels, cfg, runtime, onChunk) {
  const n = channels[0].length;
  const size = cfg.chunkSamples;
  const trim = cfg.nFft / 2;
  const gen = size - 2 * trim;
  const padded = trim + n + gen + trim - (n % gen);
  const step = Math.floor(size * 0.75);
  const starts = [];
  for (let s = 0; s < trim + n; s += step) starts.push(s);

  const acc = [new Float32Array(n), new Float32Array(n)];
  const weight = new Float32Array(n);
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const len = Math.min(size, padded - start);
    onChunk(k, starts.length);
    const stereo = [new Float32Array(size), new Float32Array(size)];
    for (let c = 0; c < 2; c++) {
      const src = channels[Math.min(c, channels.length - 1)];
      const lo = Math.max(0, start - trim);
      const hi = Math.min(n, start + len - trim);
      if (hi > lo) stereo[c].set(src.subarray(lo, hi), lo + trim - start);
    }
    const { output } = await runtime.run({ input: [toTensor(stereo, cfg), [1, 4, cfg.dimF, cfg.dimT]] });
    const vocals = fromTensor(output, size, cfg);
    for (let e = Math.max(0, trim - start); e < len && start + e - trim < n; e++) {
      const pos = start + e - trim;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * e) / (len - 1));
      weight[pos] += w;
      acc[0][pos] += vocals[0][e] * w;
      acc[1][pos] += vocals[1][e] * w;
    }
  }
  return channels.map((_, c) =>
    Float32Array.from({ length: n }, (_, i) => {
      if (!(weight[i] > 0)) throw new Error('보컬 분리 구간 연결에 실패했습니다.');
      const v = channels.length === 1 ? (acc[0][i] + acc[1][i]) / 2 : acc[c][i];
      return (v / weight[i]) * cfg.compensate;
    }),
  );
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'separate') return;
  let runtime;
  try {
    const { channels, sampleRate, baseURL } = data;
    if (sampleRate !== SR || !Array.isArray(channels) || ![1, 2].includes(channels.length) ||
        !channels[0]?.length || channels.some((c) => c.length !== channels[0].length)) {
      throw new Error('지원하지 않는 오디오 형식입니다.');
    }
    const loaded = await loadModel(baseURL, data.preferGPU !== false);
    runtime = loaded.runtime;
    const vocals = await separateVocals(channels, loaded.cfg, runtime, (k, total) =>
      progress(
        3 + (92 * k) / total,
        `${runtime.backend === 'webgpu' ? 'GPU 가속으로 보컬과 반주를 분리하는 중' : '보컬과 반주를 분리하는 중'} · ${k + 1}/${total} 구간`,
      ),
    );
    const accompaniment = channels.map((ch, c) => Float32Array.from(ch, (v, i) => v - vocals[c][i]));
    [...vocals, ...accompaniment].forEach((a) => assertFinite(a));
    const { backend, gpuFallback } = runtime;
    await runtime.release();
    runtime = null;
    progress(100, '보컬과 반주 분리가 끝났습니다.');
    self.postMessage(
      { type: 'result', clean: vocals, music: accompaniment, backend, gpuFallback, model: loaded.cfg.name },
      [...vocals, ...accompaniment].map((a) => a.buffer),
    );
  } catch (err) {
    if (runtime) await runtime.release().catch(() => {});
    self.postMessage({ type: 'error', message: err?.message || '보컬 분리 중 오류가 발생했습니다.' });
  }
};
