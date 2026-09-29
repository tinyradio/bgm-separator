// onnxruntime-web session wrapper: WebGPU when available, WASM otherwise,
// and a transparent switch to WASM if a GPU run fails midway.

export async function requestGPUAdapter() {
  if (!self.navigator.gpu) return null;
  try {
    const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return null;
    return adapter;
  } catch {
    return null;
  }
}

const SESSION_OPTIONS = {
  graphOptimizationLevel: 'all',
  enableCpuMemArena: false,
  enableMemPattern: false,
};

// The .wasm binaries are resolved by the bundler from each ort bundle's import.meta.url.
function configure(ort) {
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, self.navigator.hardwareConcurrency || 2))
    : 1;
  ort.env.wasm.proxy = false;
}

/**
 * @param {ArrayBuffer} model
 * @returns runtime with run(feeds) where feeds = { name: [Float32Array, dims] }
 */
export async function createRuntime(model, { preferGPU = true, onFallback = () => {} } = {}) {
  const adapter = preferGPU ? await requestGPUAdapter() : null;
  let backend = adapter ? 'webgpu' : 'wasm';
  let fellBack = false;
  let ort;
  let session;

  const release = async () => {
    const s = session;
    session = null;
    if (s) await s.release().catch(() => {});
  };

  const switchToWasm = async () => {
    await release();
    backend = 'wasm';
    fellBack = true;
    onFallback();
    ort = await import('onnxruntime-web/wasm');
    configure(ort);
    session = await ort.InferenceSession.create(model, { ...SESSION_OPTIONS, executionProviders: ['wasm'] });
  };

  try {
    ort = adapter ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
    configure(ort);
    session = await ort.InferenceSession.create(model, { ...SESSION_OPTIONS, executionProviders: [backend] });
  } catch (err) {
    if (backend !== 'webgpu') throw err;
    await switchToWasm();
  }

  async function runOnce(feeds) {
    const inputs = {};
    for (const [name, [data, dims]] of Object.entries(feeds)) inputs[name] = new ort.Tensor('float32', data, dims);
    let outputs;
    try {
      outputs = await session.run(inputs);
      const result = {};
      for (const [name, tensor] of Object.entries(outputs)) {
        const data = new Float32Array(await tensor.getData());
        for (let i = 0; i < data.length; i++) {
          if (!Number.isFinite(data[i])) throw new Error('분리 모델의 계산 결과가 올바르지 않습니다.');
        }
        result[name] = data;
      }
      return result;
    } finally {
      for (const t of [...Object.values(outputs || {}), ...Object.values(inputs)]) {
        try { t.dispose(); } catch {}
      }
    }
  }

  return {
    get backend() { return backend; },
    get gpuFallback() { return fellBack; },
    async run(feeds) {
      try {
        return await runOnce(feeds);
      } catch (err) {
        if (backend !== 'webgpu') throw err;
        await switchToWasm();
        return runOnce(feeds);
      }
    },
    release,
  };
}

/** Fetches a model file and checks its SHA-256 against the manifest. */
export async function fetchVerified(url, sha256, failMessage) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(failMessage);
  const buf = await res.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== sha256) throw new Error('분리 모델 파일 검증에 실패했습니다. 새로고침 후 다시 시도해 주세요.');
  return buf;
}

export async function fetchJSON(url, failMessage) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(failMessage);
  return res.json();
}
