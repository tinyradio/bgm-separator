# BGM OFF — 배경음악 분리

**배포:** https://bgm-separator.vercel.app

영상에서 배경음악만 덜어내고(대사·효과음 유지), 또는 뮤비에서 보컬과 반주를 나누는 **100% 브라우저 도구**입니다.
영상은 서버로 업로드되지 않고, 화면 트랙은 재인코딩 없이 그대로 복사됩니다.

## 실행

```bash
npm install
npm run setup   # ffmpeg 코어 복사 + 모델(~210MB) 다운로드, SHA-256 검증
npm run dev     # http://localhost:5173
npm run build   # dist/ → 정적 호스팅(GitHub Pages 등)에 그대로 배포
```

모델 다운로드 위치는 `MODEL_BASE` 환경변수로 바꿀 수 있습니다.

UI는 원티드 디자인 시스템(WDS, `@wanteddev/wds`) 컴포넌트와 토큰, Pretendard 폰트로 구성했습니다.

## 동작 방식

| 단계 | 구현 |
| --- | --- |
| 영상 분석·오디오 추출 | ffmpeg.wasm (`ffprobe`로 스트림·패킷 정보, 44.1kHz float PCM 추출) |
| 구간 자르기 | 키프레임 경계에 맞춘 stream copy, 패킷 해시로 원본과 대조 |
| 배경음 분리 | BandIt v2(48kHz, 마스크) + TIGER-DnR(44.1kHz, 음악 스템) → TF 마스크 합의 |
| 보컬 분리 | UVR-MDX-NET-Voc_FT (n_fft 7680, Bluestein FFT) |
| 재조립·검증 | 영상 `-c:v copy` + 새 오디오, 결과 영상 스트림 SHA-256·패킷 간격 대조 |

모드별 마스크: **약하게** = √(BandIt × TIGER), **중간** = 위 값과 BandIt 50:50, **세게** = BandIt 단독.

추론은 onnxruntime-web(WebGPU → 실패 시 WASM)로 돌리며, onnxruntime-web에 WebGPU GRU 커널이 없어서
BandIt의 16층 TF-RNN은 `src/engine/tfrnn-webgpu.js`의 WGSL 커널로 직접 계산합니다(ONNX 결과와 상대오차 ~1e-7).

정적 호스트에서도 WASM 멀티스레드를 쓰기 위해 `public/isolation*.js` 서비스워커가 COOP/COEP 헤더를 붙입니다.

## 구조

```
src/
  App.jsx, components/    UI — React + 원티드 디자인 시스템(@wanteddev/wds)
  style.js                WDS 토큰 기반 커스텀 스타일
  pipeline.js             ffmpeg 파이프라인 + 원본 보존 검증
  wav.js                  WAV 인코딩/디코딩
  dsp/fft.js, stft.js     FFT(radix-2/Bluestein), STFT/iSTFT, 리샘플러
  engine/runtime.js       onnxruntime-web 세션 래퍼(GPU→WASM 폴백)
  engine/tfrnn-webgpu.js  BandIt TF-RNN WebGPU 구현
  workers/                separation.worker.js, vocals.worker.js
```

## 라이선스·출처

- BandIt v2 — 코드 Apache-2.0, 가중치 **CC BY-SA 4.0** (변환된 ONNX도 동일 조건)
- TIGER-DnR — 가중치 Apache-2.0, 구조 MIT
- UVR-MDX-NET-Voc_FT — MIT
- 브라우저용으로 변환된 ONNX 파일은 기본적으로 promptwhat/bgm-separator 배포본에서 받습니다.
