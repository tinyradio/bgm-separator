// Video pipeline on ffmpeg.wasm: probe → (lossless range cut) → extract audio →
// separate in a worker → remux the untouched video stream with the new audio →
// verify the video packets and SHA-256 match the source.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { assertChannels, decodeWav, encodeWav, safeGain } from './wav.js';

export const SAMPLE_RATE = 44100;
export const MAX_BYTES = 300 * 1024 * 1024;
export const MAX_SECONDS = 180;
export const MODES = ['dialogue', 'medium', 'strong', 'vocals'];
const EPS = 0.0011;

const siteBase = () => new URL(import.meta.env.BASE_URL, window.location.href).href;

let active = null;

function abortError() {
  const err = new Error('분리를 취소했습니다.');
  err.name = 'AbortError';
  return err;
}

export function checkSupport() {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    return { supported: false, reason: '이 브라우저는 영상 분리를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 열어 주세요.' };
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return { supported: false, reason: '안전한 HTTPS 주소에서 사이트를 열어 주세요.' };
  }
  return { supported: true, reason: '' };
}

export function cancelSeparation() {
  if (!active) return;
  active.cancelled = true;
  active.rejectWorker?.(abortError());
  active.worker?.terminate();
  active.ffmpeg?.terminate();
}

/** Parses ffprobe numbers and rationals ("30000/1001"). */
export function toSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  const n = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(value);
  return Number.isFinite(n) ? n : null;
}

function describeInput(info, fileName = '', { allowLongInput = false } = {}) {
  const streams = info.streams || [];
  const videos = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  if (!videos.length) throw new Error('영상 트랙을 찾지 못했습니다. 동영상 파일을 선택해 주세요.');
  if (!audios.length) throw new Error('이 영상에는 오디오가 없습니다.');
  const [video] = videos;
  const [audio] = audios;
  if (![1, 2].includes(audio.channels)) {
    throw new Error('이 영상은 다채널 오디오입니다. 효과음의 공간 정보를 유지하기 위해 모노·스테레오 영상만 처리합니다.');
  }
  const durations = [info.format?.duration, video.duration, audio.duration].map(toSeconds).filter((d) => d !== null && d > 0);
  const duration = Math.max(...durations);
  if (!Number.isFinite(duration)) throw new Error('영상 길이를 확인할 수 없습니다. MP4 또는 MOV 파일로 다시 시도해 주세요.');
  if (!allowLongInput && duration > MAX_SECONDS + 0.05) {
    throw new Error('전체 분리는 3분 이내의 영상만 가능합니다. 긴 영상은 처리할 구간을 선택해 주세요.');
  }
  const warnings = [];
  if (videos.length > 1) warnings.push('영상 트랙이 여러 개여서 첫 번째 영상 트랙을 사용했습니다.');
  if (audios.length > 1) warnings.push('오디오 트랙이 여러 개여서 첫 번째 오디오 트랙을 분리했습니다.');
  if (streams.some((s) => ['subtitle', 'data', 'attachment'].includes(s.codec_type))) {
    warnings.push('별도 자막·데이터·첨부 트랙은 결과 영상에 포함되지 않습니다. 화면에 들어 있는 자막은 그대로 유지됩니다.');
  }
  const ext = fileName.split('.').pop().toLowerCase();
  const formatName = info.format?.format_name || '';
  const outputExtension = ext === 'mov' ? 'mov' : ext === 'webm' ? 'webm' : formatName.includes('matroska') ? 'mkv' : 'mp4';
  return {
    video,
    audio,
    duration,
    timelineEnd: Math.max(
      duration,
      (toSeconds(video.start_time) ?? 0) + (toSeconds(video.duration) ?? 0),
      (toSeconds(audio.start_time) ?? 0) + (toSeconds(audio.duration) ?? 0),
    ),
    warnings,
    outputExtension,
    width: video.width,
    height: video.height,
    fps: toSeconds(video.avg_frame_rate) || toSeconds(video.r_frame_rate),
    frameCount: toSeconds(video.nb_frames),
    audioStart: toSeconds(audio.start_time) ?? 0,
    formatStart: toSeconds(info.format?.start_time) ?? 0,
  };
}

/**
 * Snaps a requested [start, end] to keyframe boundaries so the video can be cut
 * with stream copy, and checks no kept packet depends on frames outside the cut.
 */
function planRange(packets, range, input) {
  const start = Number(range?.start);
  const end = Number(range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('영상 안에서 올바른 시작·끝 시간을 선택해 주세요.');
  }
  if (end - start > MAX_SECONDS + 0.001) throw new Error('분리할 구간은 3분 이내로 선택해 주세요.');
  if (!Array.isArray(packets) || !packets.length) throw new Error('구간을 나눌 영상 프레임 정보를 읽지 못했습니다.');
  const pts = packets.map((p) => toSeconds(p.pts_time));
  if (pts.some((t) => t === null)) throw new Error('이 영상은 프레임 시간을 확인할 수 없어 무손실 구간 자르기를 지원하지 않습니다.');

  let first = -1;
  let stop = packets.length;
  for (let i = 0; i < packets.length; i++) {
    if (!packets[i].flags?.includes('K')) continue;
    if (pts[i] <= start + 1e-6) first = i;
    if (pts[i] >= end - 1e-6) { stop = i; break; }
  }
  if (first < 0) first = packets.findIndex((p) => p.flags?.includes('K'));
  if (first < 0 || first >= stop) throw new Error('선택한 위치에서 독립적으로 재생할 수 있는 영상 시작점을 찾지 못했습니다.');

  const absoluteStart = pts[first];
  const frameDur = input.fps ? 1 / input.fps : 0;
  let lastEnd = -Infinity;
  for (let i = 0; i < packets.length; i++) lastEnd = Math.max(lastEnd, pts[i] + (toSeconds(packets[i].duration_time) || frameDur));
  if (end > Math.max(input.timelineEnd ?? input.duration, lastEnd) + 0.1) throw new Error('영상 안에서 올바른 시작·끝 시간을 선택해 주세요.');
  const absoluteEnd = stop < packets.length ? pts[stop] : lastEnd;
  if (start >= lastEnd - 1e-6) throw new Error('영상이 끝나기 전의 구간을 선택해 주세요.');
  const duration = absoluteEnd - absoluteStart;
  if (!(duration > 0) || duration > MAX_SECONDS + 0.001) {
    throw new Error(`화질을 유지하는 자르기 경계에 맞추면 ${duration.toFixed(2)}초가 됩니다. 실제 처리 구간이 3분 이내가 되도록 시작이나 끝을 조금 줄여 주세요.`);
  }

  const kept = packets.slice(first, stop);
  const keptPts = pts.slice(first, stop);
  let keptEnd = -Infinity;
  for (let i = 0; i < kept.length; i++) {
    const t = keptPts[i] + (toSeconds(kept[i].duration_time) || frameDur);
    keptEnd = Math.max(keptEnd, t);
    if (keptPts[i] < absoluteStart - EPS || t > absoluteEnd + EPS) {
      throw new Error('이 영상의 구간 경계에는 다른 구간에 의존하는 프레임이 있어 안전하게 자르지 못했습니다. 시작·끝 위치를 바꿔 주세요.');
    }
  }
  if (Math.abs(keptEnd - absoluteEnd) > EPS) throw new Error('끝 경계의 프레임을 모두 보존할 수 없습니다. 끝 위치를 다른 영상 경계로 옮겨 주세요.');

  // Seek halfway between the start keyframe and the next one so ffmpeg lands exactly on it.
  let nextKey = absoluteEnd;
  for (let i = first + 1; i < packets.length; i++) {
    if (packets[i].flags?.includes('K')) { nextKey = pts[i]; break; }
  }
  return {
    packets: kept,
    packetCount: kept.length,
    absoluteStart,
    absoluteEnd,
    inputSeek: absoluteStart - (input.formatStart ?? 0),
    videoSeek: absoluteStart + (nextKey - absoluteStart) / 2 - (input.formatStart ?? 0),
    duration,
    report: {
      requestedStart: start,
      requestedEnd: end,
      actualStart: absoluteStart,
      actualEnd: absoluteEnd,
      startAdjusted: Math.abs(absoluteStart - start) > EPS,
      endAdjusted: Math.abs(absoluteEnd - end) > EPS,
    },
  };
}

/** Packet-by-packet comparison of size, flags, relative timing (and data hash when asked). */
function comparePackets(source, output, tolerance = EPS, checkHash = false, allowMissingDts = false) {
  if (!Array.isArray(source) || !source.length || !Array.isArray(output) || source.length !== output.length) {
    return { verified: false, reason: '영상 프레임 데이터 수가 원본과 다릅니다.' };
  }
  const offset = { pts_time: null, dts_time: null };
  let sawDts = false;
  for (let i = 0; i < source.length; i++) {
    const a = source[i];
    const b = output[i];
    if (checkHash && (!a.data_hash || !b.data_hash || a.data_hash !== b.data_hash)) {
      return { verified: false, reason: '선택 구간의 영상 프레임 내용이 원본과 다릅니다.' };
    }
    if (String(a.size) !== String(b.size) || a.flags !== b.flags) return { verified: false, reason: '영상 프레임 데이터가 원본과 다릅니다.' };
    for (const key of ['pts_time', 'dts_time', 'duration_time']) {
      const x = toSeconds(a[key]);
      const y = toSeconds(b[key]);
      if (x === null || y === null) {
        if (key === 'dts_time' && allowMissingDts && !sawDts) continue;
        if (x !== y) return { verified: false, reason: '영상 프레임 시간 정보를 확인할 수 없습니다.' };
        continue;
      }
      if (key === 'dts_time') sawDts = true;
      if (key !== 'duration_time' && offset[key] === null) offset[key] = y - x;
      const drift = key === 'duration_time' ? y - x : y - x - offset[key];
      if (Math.abs(drift) > tolerance) return { verified: false, reason: '영상 프레임 간격이 원본과 다릅니다.' };
    }
  }
  return { verified: true, count: source.length, timestampOffset: offset.pts_time ?? 0 };
}

async function run(ffmpeg, args, message) {
  if ((await ffmpeg.exec(args)) !== 0) throw new Error(message);
}

async function readText(ffmpeg, path) {
  const data = await ffmpeg.readFile(path);
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

async function probe(ffmpeg, input, output, streamIndex, withHash = false) {
  const args = ['-v', 'error'];
  if (streamIndex === undefined) args.push('-show_streams', '-show_format');
  else {
    args.push('-select_streams', String(streamIndex), '-show_packets', '-show_entries',
      `packet=pts_time,dts_time,duration_time,size,flags${withHash ? ',data_hash' : ''}`);
    if (withHash) args.push('-show_data_hash', 'sha256');
  }
  args.push('-of', 'json', input, '-o', output);
  const code = await ffmpeg.ffprobe(args);
  if (code !== 0 && code !== -1) throw new Error('영상 정보를 읽지 못했습니다. 지원되는 MP4·MOV·MKV·WebM 파일인지 확인해 주세요.');
  let json;
  try {
    json = JSON.parse(await readText(ffmpeg, output));
  } catch {
    throw new Error('영상 정보를 해석하지 못했습니다.');
  }
  if (streamIndex === undefined ? !Array.isArray(json.streams) || !json.format : !Array.isArray(json.packets)) {
    throw new Error('영상 정보를 충분히 읽지 못했습니다.');
  }
  await ffmpeg.deleteFile(output);
  return json;
}

/** SHA-256 of the video elementary stream (stream copy, no decode). */
async function videoStreamHash(ffmpeg, input, index, output) {
  await run(ffmpeg, ['-v', 'error', '-i', input, '-map', `0:${index}`, '-c:v', 'copy', '-an', '-f', 'hash', '-hash', 'sha256', output],
    '원본 영상 보존 검사를 실행하지 못했습니다.');
  const match = (await readText(ffmpeg, output)).match(/SHA256=([0-9a-f]{64})/i);
  await ffmpeg.deleteFile(output);
  if (!match) throw new Error('영상 보존 확인값을 읽지 못했습니다.');
  return match[1].toLowerCase();
}

function separateInWorker(job, channels, sampleRate, onProgress) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(abortError());
    const worker = job.mode === 'vocals'
      ? new Worker(new URL('./workers/vocals.worker.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('./workers/separation.worker.js', import.meta.url), { type: 'module' });
    job.worker = worker;
    job.rejectWorker = reject;
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.percent, data.message);
      if (data.type === 'result') { job.rejectWorker = null; resolve(data); }
      if (data.type === 'error') { job.rejectWorker = null; reject(new Error(data.message || '오디오 분리에 실패했습니다.')); }
    };
    worker.onerror = (e) => reject(new Error(e.message || '분리 엔진을 실행하지 못했습니다. 브라우저를 새로 열어 주세요.'));
    worker.onmessageerror = () => reject(new Error('분리 결과를 불러오지 못했습니다.'));
    worker.postMessage(
      {
        type: 'separate',
        channels,
        sampleRate,
        strong: job.mode === 'strong',
        medium: job.mode === 'medium',
        baseURL: siteBase(),
      },
      channels.map((c) => c.buffer),
    );
  });
}

/**
 * @param {File} file
 * @param {{mode?: string, range?: {start:number,end:number}|null, onProgress?: Function}} options
 */
export async function separateVideo(file, { mode = 'dialogue', range = null, onProgress = () => {} } = {}) {
  if (!MODES.includes(mode)) throw new Error('분리 모드를 다시 선택해 주세요.');
  if (active) throw new Error('현재 영상을 처리 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
  if (!file || !file.size) throw new Error('동영상 파일을 선택해 주세요.');
  if (file.size > MAX_BYTES) throw new Error('한 번에 300MB 이하의 영상을 처리할 수 있습니다.');
  const support = checkSupport();
  if (!support.supported) throw new Error(support.reason);

  const startedAt = performance.now();
  const job = { ffmpeg: new FFmpeg(), worker: null, cancelled: false, rejectWorker: null, mode };
  active = job;
  const ffmpeg = job.ffmpeg;
  let shown = 0;
  const report = (percent, message, stage) => {
    if (job.cancelled) throw abortError();
    shown = Math.max(shown, Math.min(100, Number(percent) || 0));
    onProgress({ percent: shown, message, stage });
  };

  try {
    report(1, '영상 엔진을 준비하고 있어요. 첫 실행에는 잠시 걸립니다.', 'loading');
    const base = siteBase();
    await ffmpeg.load({
      coreURL: new URL('vendor/ffmpeg/ffmpeg-core.js', base).href,
      wasmURL: new URL('vendor/ffmpeg/ffmpeg-core.wasm', base).href,
    });
    if (job.cancelled) throw abortError();

    report(5, '영상과 오디오 정보를 확인하고 있어요.', 'inspect');
    const ext = (file.name?.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
    const source = `source.${ext}`;
    await ffmpeg.writeFile(source, new Uint8Array(await file.arrayBuffer()));
    const input = describeInput(await probe(ffmpeg, source, 'input-info.json'), file.name, { allowLongInput: range !== null });
    let sourcePackets = (await probe(ffmpeg, source, 'input-packets.json', input.video.index, range !== null)).packets;

    let videoFile = source;
    let videoIndex = input.video.index;
    let audioOffset = input.audioStart;
    let cut = null;
    if (range !== null) {
      cut = planRange(sourcePackets, range, input);
      videoFile = `selected-video.${input.outputExtension}`;
      report(7, `원본 화질을 유지하는 ${cut.report.actualStart.toFixed(2)}~${cut.report.actualEnd.toFixed(2)}초 구간을 준비하고 있어요.`, 'range');
      await run(ffmpeg, [
        '-v', 'error', '-copyts', '-ss', String(cut.videoSeek), '-i', source,
        '-map', `0:${input.video.index}`, '-an', '-map_metadata', '0', '-map_chapters', '-1',
        '-c:v', 'copy', '-copytb', '1', '-frames:v', String(cut.packetCount),
        '-output_ts_offset', String(-cut.absoluteStart), '-avoid_negative_ts', 'disabled', videoFile,
      ], '선택 구간을 원본 화질로 자르지 못했습니다. 영상은 재압축하지 않았습니다.');
      const clipVideo = (await probe(ffmpeg, videoFile, 'clip-info.json')).streams.find((s) => s.codec_type === 'video');
      if (!clipVideo) throw new Error('선택 구간의 영상 트랙을 찾지 못했습니다.');
      videoIndex = clipVideo.index;
      const clipPackets = (await probe(ffmpeg, videoFile, 'clip-packets.json', videoIndex, true)).packets;
      const check = comparePackets(cut.packets, clipPackets, EPS, true, input.outputExtension === 'mkv');
      if (!check.verified || clipVideo.width !== input.width || clipVideo.height !== input.height) {
        throw new Error(`선택 구간을 원본과 동일하게 보존하지 못해 처리를 중단했습니다. ${check.reason || ''}`);
      }
      audioOffset = toSeconds(clipVideo.start_time) ?? toSeconds(clipPackets[0]?.pts_time) ?? 0;
      if (Math.abs(audioOffset) > EPS) throw new Error('선택 구간의 시작 시간을 정확하게 맞추지 못했습니다. 다른 경계로 다시 선택해 주세요.');
      sourcePackets = clipPackets;
      cut.packets = null;
    }
    const sourceHash = await videoStreamHash(ffmpeg, videoFile, videoIndex, 'input-hash.txt');

    report(10, '원본 영상은 보관하고 소리만 읽고 있어요.', 'extract');
    let audio;
    const targetSamples = cut ? Math.round(cut.duration * SAMPLE_RATE) : null;
    const audioEnd = input.audioStart + (toSeconds(input.audio.duration) ?? Infinity);
    if (cut && (input.audioStart >= cut.absoluteEnd || audioEnd <= cut.absoluteStart)) {
      audio = {
        channels: Array.from({ length: input.audio.channels }, () => new Float32Array(targetSamples)),
        sampleRate: SAMPLE_RATE,
        sampleCount: targetSamples,
      };
    } else {
      const seek = cut && cut.inputSeek !== 0 ? ['-ss', String(cut.inputSeek)] : [];
      const filter = cut
        ? `aresample=${SAMPLE_RATE}:async=1:first_pts=0,apad=whole_len=${targetSamples},atrim=end_sample=${targetSamples}`
        : `asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE}:async=1:first_pts=0`;
      await run(ffmpeg, [
        '-v', 'error', '-nocopyts', ...seek, '-i', source, '-map', `0:${input.audio.index}`, '-vn',
        ...(cut ? ['-t', String(cut.duration)] : []),
        '-af', filter, '-ar', String(SAMPLE_RATE), '-ac', String(input.audio.channels), '-c:a', 'pcm_f32le', 'source-audio.wav',
      ], '오디오를 읽지 못했습니다. 이 파일의 오디오 형식을 지원하지 않을 수 있습니다.');
      audio = decodeWav(await ffmpeg.readFile('source-audio.wav'));
      await ffmpeg.deleteFile('source-audio.wav');
      if (cut && audio.sampleCount !== targetSamples) throw new Error('선택 구간과 오디오 길이를 정확히 맞추지 못했습니다.');
    }
    if (cut) await ffmpeg.deleteFile(source);
    if (audio.sampleRate !== SAMPLE_RATE || audio.sampleCount / SAMPLE_RATE > MAX_SECONDS + 0.1) {
      throw new Error('3분을 넘는 오디오는 처리할 수 없습니다.');
    }

    const channelCount = audio.channels.length;
    const sampleCount = audio.sampleCount;
    const separatingText = mode === 'vocals' ? '노래 보컬과 반주를 분리하고 있어요.' : '음악과 대사·효과음을 분리하고 있어요.';
    report(15, separatingText, 'separate');
    const separated = await separateInWorker(job, audio.channels, SAMPLE_RATE, (p, message) =>
      report(15 + Math.min(100, Math.max(0, Number(p) || 0)) * 0.65, message || separatingText, 'separate'),
    );
    job.worker.terminate();
    job.worker = null;
    assertChannels(separated.clean, sampleCount, channelCount);
    assertChannels(separated.music, sampleCount, channelCount);

    report(81, '분리한 소리를 저장하고 있어요.', 'encode');
    const cleanWav = encodeWav(separated.clean, SAMPLE_RATE);
    const musicWav = encodeWav(separated.music, SAMPLE_RATE);
    const gain = safeGain(separated.clean);
    const cleanAudioBlob = new Blob([cleanWav], { type: 'audio/wav' });
    const musicBlob = new Blob([musicWav], { type: 'audio/wav' });
    await ffmpeg.writeFile('clean.wav', cleanWav);

    const outExt = input.outputExtension;
    const output = `result.${outExt}`;
    const opusRate = channelCount === 1 ? '256k' : '320k';
    const audioCodec = outExt === 'mkv' ? ['-c:a', 'flac']
      : outExt === 'webm' ? ['-c:a', 'libopus', '-b:a', opusRate]
      : ['-c:a', 'aac', '-b:a', '320k'];
    const movFlags = ['mp4', 'mov'].includes(outExt) ? ['-movflags', '+faststart+use_metadata_tags'] : [];
    report(85, '화질과 프레임을 그대로 유지해 영상을 합치고 있어요.', 'mux');
    await run(ffmpeg, [
      '-v', 'error', '-copyts', '-i', videoFile, '-itsoffset', String(audioOffset), '-i', 'clean.wav',
      '-map', `0:${videoIndex}`, '-map', '1:a:0', '-map_metadata', '0', '-map_chapters', cut ? '-1' : '0',
      '-c:v', 'copy', '-copytb', '1',
      ...(gain.gain < 1 ? ['-af', `volume=${gain.gain}`] : []),
      ...audioCodec, '-avoid_negative_ts', 'disabled', ...movFlags, output,
    ], '원본 화질을 유지한 채 이 파일 형식에 저장하지 못했습니다. 영상 재압축은 하지 않았습니다. MP4·MOV 영상으로 다시 시도해 주세요.');

    report(93, '원본과 결과의 영상 데이터·프레임 간격을 대조하고 있어요.', 'verify');
    const outVideo = (await probe(ffmpeg, output, 'output-info.json')).streams?.find((s) => s.codec_type === 'video');
    if (!outVideo) throw new Error('결과의 영상 트랙이 없습니다. 파일을 만들지 않았습니다.');
    const outPackets = (await probe(ffmpeg, output, 'output-packets.json', outVideo.index)).packets;
    const outHash = await videoStreamHash(ffmpeg, output, outVideo.index, 'output-hash.txt');
    const check = comparePackets(sourcePackets, outPackets);
    if (sourceHash !== outHash || !check.verified || input.width !== outVideo.width || input.height !== outVideo.height) {
      throw new Error(`원본 영상 보존 검사에 통과하지 못해 결과를 제공하지 않았습니다. ${check.reason || '영상 데이터가 원본과 일치하지 않습니다.'}`);
    }

    const mime = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm' }[outExt];
    const videoBlob = new Blob([await ffmpeg.readFile(output)], { type: mime });
    const warnings = [...input.warnings];
    if (cut?.report.startAdjusted || cut?.report.endAdjusted) {
      warnings.push(`영상 재압축 없이 보존하기 위해 실제 처리 구간을 ${cut.report.actualStart.toFixed(2)}~${cut.report.actualEnd.toFixed(2)}초로 맞췄습니다. 원래 선택: ${cut.report.requestedStart.toFixed(2)}~${cut.report.requestedEnd.toFixed(2)}초.`);
    }
    if (gain.gain < 1) {
      warnings.push(`큰 소리의 찌그러짐을 줄이기 위해 결과 영상의 음량을 ${Math.abs(gain.gainDb).toFixed(1)}dB 낮췄습니다. 별도 WAV의 음량과 샘플은 그대로입니다.`);
    }
    if (outExt === 'mkv' || outExt === 'mov') {
      warnings.push('이 파일 형식은 브라우저 미리보기가 지원되지 않을 수 있습니다. 다운로드 후 영상 플레이어에서 확인해 주세요.');
    }
    const audioEncoding = outExt === 'mkv' ? 'FLAC' : outExt === 'webm' ? `Opus ${parseInt(opusRate, 10)} kbps` : 'AAC 320 kbps';
    report(100, '분리가 끝났어요. 원본 영상 데이터가 그대로인 것도 확인했습니다.', 'done');

    return {
      videoBlob,
      musicBlob,
      cleanAudioBlob,
      report: {
        width: input.width,
        height: input.height,
        fps: (cut && toSeconds(outVideo.avg_frame_rate)) || input.fps,
        frameCount: cut ? check.count : input.frameCount ?? check.count,
        videoVerified: true,
        timestampsVerified: true,
        videoPacketCount: check.count,
        inputName: file.name,
        duration: cut ? cut.duration : input.duration,
        sourceDuration: input.timelineEnd,
        elapsedSeconds: (performance.now() - startedAt) / 1000,
        outputExtension: outExt,
        audioEncoding,
        videoAudioGainDb: gain.gainDb,
        warnings,
        originalVideoHash: sourceHash,
        outputVideoHash: outHash,
        mode,
        separationModel: separated.model,
        separationBackend: separated.backend,
        gpuFallback: separated.gpuFallback,
        ...(cut ? { range: cut.report, sourceRangeVerified: true } : {}),
      },
    };
  } catch (err) {
    if (job.cancelled) throw abortError();
    if (err instanceof Error) throw err;
    throw new Error(typeof err === 'string' ? err : '영상 처리에 실패했습니다. 브라우저를 다시 열고 짧은 영상으로 시도해 주세요.');
  } finally {
    job.worker?.terminate();
    ffmpeg.terminate();
    if (active === job) active = null;
  }
}
