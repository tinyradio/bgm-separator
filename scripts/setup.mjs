// Copies the ffmpeg.wasm core into public/vendor and
// downloads the separation models into public/models, verifying SHA-256.
//
//   node scripts/setup.mjs            vendor + models
//   node scripts/setup.mjs --vendor   vendor only (runs before dev/build)
//
// MODEL_BASE overrides where the converted ONNX models are downloaded from.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const MODEL_BASE = (process.env.MODEL_BASE || 'https://promptwhat.github.io/bgm-separator/models/').replace(/\/?$/, '/');

async function copyVendor() {
  const ffmpegSrc = join(root, 'node_modules/@ffmpeg/core/dist/esm');
  const ffmpegDst = join(pub, 'vendor/ffmpeg');
  await mkdir(ffmpegDst, { recursive: true });
  for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) await copyIfChanged(join(ffmpegSrc, f), join(ffmpegDst, f));

  console.log('✓ ffmpeg core copied to public/vendor');
}

async function copyIfChanged(src, dst) {
  if (existsSync(dst)) {
    const [a, b] = await Promise.all([stat(src), stat(dst)]);
    if (a.size === b.size && a.mtimeMs <= b.mtimeMs) return;
  }
  await copyFile(src, dst);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchBytes(name) {
  const res = await fetch(MODEL_BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureModel(dir, name, hash) {
  const path = join(dir, name);
  if (existsSync(path) && sha256(await readFile(path)) === hash) {
    console.log(`  = ${name} (cached)`);
    return;
  }
  process.stdout.write(`  ↓ ${name} … `);
  const bytes = await fetchBytes(name);
  const got = sha256(bytes);
  if (got !== hash) throw new Error(`${name}: SHA-256 mismatch (${got})`);
  await writeFile(path, bytes);
  console.log(`${(bytes.length / 1048576).toFixed(1)} MB ✓`);
}

async function fetchModels() {
  const dir = join(pub, 'models');
  await mkdir(dir, { recursive: true });
  console.log(`Downloading models from ${MODEL_BASE}`);

  const manifests = {};
  for (const name of ['bandit.json', 'tiger-2pass.json', 'vocals.json']) {
    const bytes = await fetchBytes(name);
    manifests[name] = JSON.parse(bytes.toString('utf8'));
    await writeFile(join(dir, name), bytes);
  }
  for (const [file, { sha256: hash }] of Object.entries(manifests['bandit.json'].files)) await ensureModel(dir, file, hash);
  await ensureModel(dir, manifests['tiger-2pass.json'].file, manifests['tiger-2pass.json'].sha256);
  await ensureModel(dir, 'uvr-vocals.onnx', manifests['vocals.json'].sha256);
  console.log('✓ models ready in public/models');
}

await copyVendor();
if (!process.argv.includes('--vendor')) await fetchModels();
