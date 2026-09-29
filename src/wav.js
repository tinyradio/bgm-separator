const tag = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** Decodes PCM16/24/32 or float32 WAV into per-channel Float32Arrays. */
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') {
    throw new Error('오디오를 읽지 못했습니다. 올바른 WAV 형식이 아닙니다.');
  }
  let fmt;
  let data;
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = tag(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (size > view.byteLength - body) throw new Error('오디오 파일의 일부가 누락되었습니다.');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('오디오 형식 정보가 올바르지 않습니다.');
      let encoding = view.getUint16(body, true);
      if (encoding === 0xfffe) {
        if (size < 40) throw new Error('오디오 확장 형식 정보가 올바르지 않습니다.');
        encoding = view.getUint16(body + 24, true);
      }
      fmt = {
        encoding,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data' && !data) {
      data = { start: body, size };
    }
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('오디오 데이터가 없습니다.');
  const { encoding, channels, sampleRate, blockAlign, bits } = fmt;
  if (channels < 1 || channels > 2 || sampleRate < 1) throw new Error('모노·스테레오 오디오만 지원합니다.');
  if (!((encoding === 3 && bits === 32) || (encoding === 1 && [16, 24, 32].includes(bits)))) {
    throw new Error('지원하지 않는 WAV 오디오 형식입니다.');
  }
  if (blockAlign !== (bits / 8) * channels || data.size % blockAlign) throw new Error('오디오 샘플 정보가 올바르지 않습니다.');
  const count = data.size / blockAlign;
  if (!count) throw new Error('분리할 오디오가 비어 있습니다.');
  const out = Array.from({ length: channels }, () => new Float32Array(count));
  let p = data.start;
  const width = bits / 8;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < channels; c++, p += width) {
      let v;
      if (encoding === 3) v = view.getFloat32(p, true);
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      else {
        let s = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608;
      }
      if (!Number.isFinite(v)) throw new Error('오디오에 읽을 수 없는 샘플이 있습니다.');
      out[c][i] = v;
    }
  }
  return { channels: out, sampleRate, sampleCount: count };
}

export function assertChannels(channels, length, count) {
  const bad =
    !Array.isArray(channels) || channels.length < 1 || channels.length > 2 ||
    (count !== undefined && count !== channels.length) ||
    channels.some((c) => !(c instanceof Float32Array) || !c.length || c.length !== channels[0].length || (length !== undefined && c.length !== length));
  if (bad) throw new Error('분리 결과의 길이 또는 채널 수가 원본과 다릅니다. 파일을 만들지 않았습니다.');
}

/** Encodes channels as 32-bit float WAV. */
export function encodeWav(channels, sampleRate) {
  assertChannels(channels);
  const frames = channels[0].length;
  const dataBytes = frames * channels.length * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 4, true);
  view.setUint16(32, channels.length * 4, true);
  view.setUint16(34, 32, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      if (!Number.isFinite(ch[i])) throw new Error('분리 결과에 올바르지 않은 오디오 샘플이 있습니다.');
      view.setFloat32(p, ch[i], true);
      p += 4;
    }
  }
  return bytes;
}

/** Peak-based gain so the muxed track stays below clipping. */
export function safeGain(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const gain = peak > 0.98 ? 0.95 / peak : 1;
  return { peak, gain, gainDb: 20 * Math.log10(gain) };
}
