// Complex FFT on split re/im Float64Arrays.
// Power-of-two sizes use iterative radix-2; other sizes use Bluestein's chirp-z.

class Radix2 {
  constructor(n) {
    if (n < 2 || n & (n - 1)) throw new Error(`FFT size must be a power of two: ${n}`);
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, v = i; b < bits; b++, v >>= 1) r = (r << 1) | (v & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  // In-place forward transform: X[k] = Σ x[j]·e^(−2πijk/n)
  forward(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k;
          const b = a + half;
          const wr = cos[t], wi = sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

class Bluestein {
  constructor(n) {
    this.n = n;
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;
    this.m = m;
    this.fft = new Radix2(m);
    // chirp w[k] = e^(−iπk²/n); (k² mod 2n) keeps the angle precise for large k
    this.wr = new Float64Array(n);
    this.wi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * ((k * k) % (2 * n))) / n;
      this.wr[k] = Math.cos(a);
      this.wi[k] = -Math.sin(a);
    }
    this.br = new Float64Array(m);
    this.bi = new Float64Array(m);
    for (let k = 0; k < n; k++) {
      this.br[k] = this.wr[k];
      this.bi[k] = -this.wi[k];
      if (k > 0) {
        this.br[m - k] = this.wr[k];
        this.bi[m - k] = -this.wi[k];
      }
    }
    this.fft.forward(this.br, this.bi);
    this.ar = new Float64Array(m);
    this.ai = new Float64Array(m);
  }

  forward(re, im) {
    const { n, m, wr, wi, br, bi, ar, ai, fft } = this;
    ar.fill(0);
    ai.fill(0);
    for (let k = 0; k < n; k++) {
      ar[k] = re[k] * wr[k] - im[k] * wi[k];
      ai[k] = re[k] * wi[k] + im[k] * wr[k];
    }
    fft.forward(ar, ai);
    // multiply by B, then inverse FFT via conj(FFT(conj(x)))/m
    for (let k = 0; k < m; k++) {
      const r = ar[k] * br[k] - ai[k] * bi[k];
      const i = ar[k] * bi[k] + ai[k] * br[k];
      ar[k] = r;
      ai[k] = -i;
    }
    fft.forward(ar, ai);
    for (let k = 0; k < n; k++) {
      const cr = ar[k] / m;
      const ci = -ai[k] / m;
      re[k] = cr * wr[k] - ci * wi[k];
      im[k] = cr * wi[k] + ci * wr[k];
    }
  }
}

const cache = new Map();

/** Returns a cached in-place forward DFT for size n. */
export function getFFT(n) {
  let f = cache.get(n);
  if (!f) {
    f = n & (n - 1) ? new Bluestein(n) : new Radix2(n);
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(n, f);
  }
  return f;
}
