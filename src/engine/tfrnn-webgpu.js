// WebGPU implementation of BandIt v2's time-frequency RNN stack.
// Each layer: z += FC(BiGRU(LayerNorm(z))), alternating the sequence axis
// between time (even layers) and bands (odd layers).
// onnxruntime-web has no WebGPU GRU kernel, so this keeps the stack on the GPU.

const EMB = 128;
const HIDDEN = 256;
const GROUP = 8; // batch items per workgroup in the GRU kernel

const LAYER_NORM = /* wgsl */ `
struct P { rows: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> gamma: array<f32>;
@group(0) @binding(4) var<storage, read> beta: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let row = (wid.y * nwg.x + wid.x) * 64u + lid.x;
  if (row >= p.rows) { return; }
  let base = row * ${EMB}u;
  var mean = 0.0;
  for (var k = 0u; k < ${EMB}u; k++) { mean += src[base + k]; }
  mean /= ${EMB}.0;
  var variance = 0.0;
  for (var k = 0u; k < ${EMB}u; k++) { let d = src[base + k] - mean; variance += d * d; }
  let inv = inverseSqrt(variance / ${EMB}.0 + 1e-5);
  for (var k = 0u; k < ${EMB}u; k++) { dst[base + k] = (src[base + k] - mean) * inv * gamma[k] + beta[k]; }
}`;

const GRU_STEP = /* wgsl */ `
struct P { seqLen: u32, batchStride: u32, stepStride: u32, step: u32, batch: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> h: array<f32>;
@group(0) @binding(3) var<storage, read> wih: array<f32>;
@group(0) @binding(4) var<storage, read> whh: array<f32>;
@group(0) @binding(5) var<storage, read> bih: array<f32>;
@group(0) @binding(6) var<storage, read> bhh: array<f32>;
const G = ${GROUP}u;
const H = ${HIDDEN}u;
const G3 = ${HIDDEN * 3}u;
var<workgroup> xs: array<f32, ${GROUP * EMB}>;
var<workgroup> hp: array<f32, ${GROUP * HIDDEN}>;
@compute @workgroup_size(${HIDDEN})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let j = lid.x;
  let dir = wid.z;
  let first = wid.x * G;
  var t = p.step;
  var prevT = p.step - 1u;
  if (dir == 1u) { t = p.seqLen - 1u - p.step; prevT = t + 1u; }

  for (var g = 0u; g < G; g++) {
    let b = min(first + g, p.batch - 1u);
    if (j < ${EMB}u) { xs[g * ${EMB}u + j] = x[(b * p.batchStride + t * p.stepStride) * ${EMB}u + j]; }
    var prev = 0.0;
    if (p.step > 0u) { prev = h[(b * p.batchStride + prevT * p.stepStride) * 512u + dir * H + j]; }
    hp[g * H + j] = prev;
  }
  workgroupBarrier();

  let wi = dir * ${EMB}u * G3;
  let wh = dir * H * G3;
  let bo = dir * G3;
  var xr: array<f32, G>; var xz: array<f32, G>; var xn: array<f32, G>;
  var hr: array<f32, G>; var hz: array<f32, G>; var hn: array<f32, G>;
  for (var g = 0u; g < G; g++) {
    xr[g] = bih[bo + j]; xz[g] = bih[bo + H + j]; xn[g] = bih[bo + 2u * H + j];
    hr[g] = bhh[bo + j]; hz[g] = bhh[bo + H + j]; hn[g] = bhh[bo + 2u * H + j];
  }
  for (var k = 0u; k < ${EMB}u; k++) {
    let o = wi + k * G3;
    let a = wih[o + j]; let c = wih[o + H + j]; let e = wih[o + 2u * H + j];
    for (var g = 0u; g < G; g++) { let v = xs[g * ${EMB}u + k]; xr[g] += a * v; xz[g] += c * v; xn[g] += e * v; }
  }
  for (var k = 0u; k < H; k++) {
    let o = wh + k * G3;
    let a = whh[o + j]; let c = whh[o + H + j]; let e = whh[o + 2u * H + j];
    for (var g = 0u; g < G; g++) { let v = hp[g * H + k]; hr[g] += a * v; hz[g] += c * v; hn[g] += e * v; }
  }
  for (var g = 0u; g < G; g++) {
    let b = first + g;
    if (b < p.batch) {
      let r = 1.0 / (1.0 + exp(-(xr[g] + hr[g])));
      let z = 1.0 / (1.0 + exp(-(xz[g] + hz[g])));
      let n = tanh(xn[g] + r * hn[g]);
      h[(b * p.batchStride + t * p.stepStride) * 512u + dir * H + j] = (1.0 - z) * n + z * hp[g * H + j];
    }
  }
}`;

const FC_RESIDUAL = /* wgsl */ `
struct P { rows: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> h: array<f32>;
@group(0) @binding(2) var<storage, read_write> z: array<f32>;
@group(0) @binding(3) var<storage, read> w: array<f32>;
@group(0) @binding(4) var<storage, read> bias: array<f32>;
var<workgroup> hs: array<f32, 512>;
@compute @workgroup_size(${EMB})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let row = wid.y * nwg.x + wid.x;
  if (row >= p.rows) { return; }
  let o = lid.x;
  for (var k = o; k < 512u; k += ${EMB}u) { hs[k] = h[row * 512u + k]; }
  workgroupBarrier();
  var acc = bias[o];
  for (var k = 0u; k < 512u; k++) { acc += hs[k] * w[k * ${EMB}u + o]; }
  z[row * ${EMB}u + o] += acc;
}`;

const grid = (n) => (n <= 65535 ? [n, 1] : [65535, Math.ceil(n / 65535)]);

/**
 * @param {GPUAdapter} adapter
 * @param {ArrayBuffer} weights raw float32 blob (bandit-tf.bin)
 * @param {{bands:number, frames:number, emb:number, hidden:number, tfLayout:{name:string,offset:number,length:number}[]}} config
 */
export async function createTfRnnGPU(adapter, weights, config) {
  const { bands, frames, emb, hidden, tfLayout } = config;
  if (emb !== EMB || hidden !== HIDDEN) throw new Error('GPU 계산 설정이 모델과 맞지 않습니다.');
  const rows = bands * frames;
  const hBytes = rows * 2 * HIDDEN * 4;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, Math.max(hBytes, 134217728)),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, Math.max(hBytes, 268435456)),
    },
  });

  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const storage = (bytes) => device.createBuffer({ size: Math.max(16, bytes), usage: STORAGE });
  const uniform = (values) => {
    const buf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, new Uint32Array(values));
    return buf;
  };

  const all = new Float32Array(weights);
  const params = {};
  let layers = 0;
  for (const { name, offset, length } of tfLayout) {
    const buf = storage(length * 4);
    device.queue.writeBuffer(buf, 0, all, offset, length);
    params[name] = buf;
    layers = Math.max(layers, Number(name.split('.')[0]) + 1);
  }

  const zBuf = storage(rows * EMB * 4);
  const yBuf = storage(rows * EMB * 4);
  const hBuf = storage(hBytes);
  const readBuf = device.createBuffer({ size: rows * EMB * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const pipeline = (code) =>
    device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const normPipe = pipeline(LAYER_NORM);
  const gruPipe = pipeline(GRU_STEP);
  const fcPipe = pipeline(FC_RESIDUAL);
  const bind = (pipe, buffers) =>
    device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });

  const rowsUniform = uniform([rows]);
  const uniforms = [rowsUniform];
  // seqLen, batchStride, stepStride, step, batch
  const timeSteps = Array.from({ length: frames }, (_, s) => uniform([frames, frames, 1, s, bands]));
  const bandSteps = Array.from({ length: bands }, (_, s) => uniform([bands, 1, frames, s, frames]));
  uniforms.push(...timeSteps, ...bandSteps);

  const plan = Array.from({ length: layers }, (_, i) => {
    const w = (n) => params[`${i}.${n}`];
    const overTime = i % 2 === 0;
    return {
      norm: bind(normPipe, [rowsUniform, zBuf, yBuf, w('norm.weight'), w('norm.bias')]),
      steps: (overTime ? timeSteps : bandSteps).map((u) =>
        bind(gruPipe, [u, yBuf, hBuf, w('w_ih_t'), w('w_hh_t'), w('b_ih'), w('b_hh')]),
      ),
      batch: overTime ? bands : frames,
      fc: bind(fcPipe, [rowsUniform, hBuf, zBuf, w('fc.weight_t'), w('fc.bias')]),
    };
  });
  const normGrid = grid(Math.ceil(rows / 64));
  const rowGrid = grid(rows);

  async function run(input) {
    if (input.length !== rows * EMB) throw new Error('GPU 계산 입력 길이가 맞지 않습니다.');
    device.queue.writeBuffer(zBuf, 0, input);
    const encoder = device.createCommandEncoder();
    for (const layer of plan) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(normPipe);
      pass.setBindGroup(0, layer.norm);
      pass.dispatchWorkgroups(normGrid[0], normGrid[1]);
      pass.setPipeline(gruPipe);
      const groups = Math.ceil(layer.batch / GROUP);
      for (const step of layer.steps) {
        pass.setBindGroup(0, step);
        pass.dispatchWorkgroups(groups, 1, 2);
      }
      pass.setPipeline(fcPipe);
      pass.setBindGroup(0, layer.fc);
      pass.dispatchWorkgroups(rowGrid[0], rowGrid[1]);
      pass.end();
    }
    encoder.copyBufferToBuffer(zBuf, 0, readBuf, 0, rows * EMB * 4);
    device.queue.submit([encoder.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return out;
  }

  async function release() {
    for (const b of [...Object.values(params), zBuf, yBuf, hBuf, readBuf, ...uniforms]) b.destroy();
    device.destroy();
  }

  return { backend: 'webgpu', run, release };
}
