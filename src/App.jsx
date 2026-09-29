import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, FlexBox, SegmentedControl, SegmentedControlItem, TextButton, Typography } from '@wanteddev/wds';
import { IconRefresh } from '@wanteddev/wds-icon';

import AboutModal from './components/AboutModal.jsx';
import ActionPanel from './components/ActionPanel.jsx';
import DropZone from './components/DropZone.jsx';
import RangeEditor from './components/RangeEditor.jsx';
import ResultReport from './components/ResultReport.jsx';
import { clamp, formatClock, formatSize, formatTime } from './format';
import { MAX_BYTES, MAX_SECONDS, cancelSeparation, checkSupport, separateVideo } from './pipeline.js';
import {
  audioRowStyle,
  cardStyle,
  containerStyle,
  headerStyle,
  hiddenInputStyle,
  logoMarkStyle,
  overlayTextStyle,
  pageStyle,
  videoStageStyle,
  workbenchStyle,
} from './style';

const ACCEPTED = /\.(mp4|mov|webm|mkv|m4v)$/i;
const STAGE_TITLES = {
  loading: '처리 도구를 준비하고 있어요',
  inspect: '영상을 확인하고 있어요',
  range: '구간을 준비하고 있어요',
  extract: '영상에서 소리를 꺼내고 있어요',
  encode: '새 오디오를 만들고 있어요',
  mux: '원본 화면에 소리를 합치고 있어요',
  verify: '영상 보존을 확인하고 있어요',
  done: '파일을 준비했어요',
};

export default function App() {
  const support = useMemo(() => checkSupport(), []);
  const [file, setFile] = useState(null);
  const [fileURL, setFileURL] = useState(null);
  const [duration, setDuration] = useState(null);
  const [ratio, setRatio] = useState(null);
  const [previewError, setPreviewError] = useState(false);
  const [mode, setMode] = useState('medium');
  const [range, setRange] = useState({ useRange: false, start: 0, end: 0, auto: false });
  const [phase, setPhase] = useState('setup');
  const [progress, setProgress] = useState({ percent: 0, title: '', message: '' });
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(support.supported ? '' : support.reason);
  const [dragging, setDragging] = useState(false);
  const [rangePlaying, setRangePlaying] = useState(false);
  const [view, setView] = useState('result');

  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const resultVideoRef = useRef(null);
  const musicRef = useRef(null);
  const jobRef = useRef(0);
  const dragDepth = useRef(0);
  const busy = phase === 'progress';
  const tooLong = Number.isFinite(duration) && duration > MAX_SECONDS + 0.001;
  const showResult = !!result && view === 'result';

  const rangeError = useMemo(() => {
    const { useRange, start, end } = range;
    if (!useRange) return tooLong ? '3분 이내의 구간을 선택해 주세요.' : '';
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '시작과 끝을 분:초 또는 초로 입력해 주세요.';
    if (start < 0 || (Number.isFinite(duration) && end > duration + 0.001)) return '영상 길이 안에서 시작과 끝을 선택해 주세요.';
    if (end <= start) return '끝은 시작보다 뒤로 지정해 주세요.';
    if (end - start > MAX_SECONDS + 0.001) return '한 번에 분리할 구간은 최대 3분이에요.';
    return '';
  }, [range, duration, tooLong]);

  const clearResult = useCallback(() => {
    setResult((prev) => {
      prev?.urls.forEach((u) => URL.revokeObjectURL(u));
      return null;
    });
    setPhase((p) => (p === 'result' ? 'setup' : p));
  }, []);

  const pauseRange = useCallback(() => {
    setRangePlaying(false);
    videoRef.current?.pause();
  }, []);

  // ── file ──
  const loadFile = useCallback((next) => {
    if (!next || busy) return;
    if (!ACCEPTED.test(next.name)) return setError(`“${next.name}”은 지원하지 않는 형식이에요. MP4, MOV, WebM, MKV 영상을 선택해 주세요.`);
    if (!next.size) return setError('비어 있는 파일이에요. 다른 영상을 선택해 주세요.');
    if (next.size > MAX_BYTES) return setError(`선택한 영상은 ${formatSize(next.size)}예요. 300MB 이하 파일을 선택해 주세요.`);
    jobRef.current += 1;
    clearResult();
    setError(support.supported ? '' : support.reason);
    setFileURL((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(next);
    });
    setFile(next);
    setDuration(null);
    setRatio(null);
    setPreviewError(false);
    setRangePlaying(false);
    setRange({ useRange: false, start: 0, end: 0, auto: false });
  }, [busy, clearResult, support]);

  const resetFile = useCallback(() => {
    if (busy) return;
    jobRef.current += 1;
    clearResult();
    setFileURL((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setFile(null);
    setDuration(null);
    setRangePlaying(false);
    setRange({ useRange: false, start: 0, end: 0, auto: false });
    setError(support.supported ? '' : support.reason);
  }, [busy, clearResult, support]);

  const takeFiles = (files) => {
    if (files.length > 1) return setError('영상은 한 번에 하나씩 처리할 수 있어요.');
    if (files.length) loadFile(files[0]);
  };

  const onMetadata = (e) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) setRatio(`${v.videoWidth} / ${v.videoHeight}`);
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    setDuration(d);
    setRange((r) => {
      if (r.useRange && r.end > 0) return r;
      const long = d > MAX_SECONDS + 0.001;
      return { useRange: long, start: 0, end: long ? Math.min(30, d) : d, auto: long };
    });
  };

  // ── range ──
  const editRange = (next) => {
    clearResult();
    setRange((r) => ({ ...r, ...next, auto: false }));
  };

  const onRangeMode = (value) => {
    if (busy) return;
    const useRange = value === 'selected';
    pauseRange();
    editRange(useRange && range.end === 0 ? { useRange, end: Number.isFinite(duration) ? duration : 30 } : { useRange });
  };

  const onSliderChange = ([a, b]) => {
    let start = a;
    let end = b;
    const movedStart = Math.abs(a - range.start) > Math.abs(b - range.end);
    if (end - start > MAX_SECONDS) {
      if (movedStart) start = end - MAX_SECONDS;
      else end = start + MAX_SECONDS;
    }
    start = Math.round(start * 1000) / 1000;
    end = Math.round(end * 1000) / 1000;
    pauseRange();
    editRange({ start, end });
    const video = videoRef.current;
    if (video && video.readyState >= 1) video.currentTime = clamp(movedStart ? start : end, 0, video.duration);
  };

  const onTimeInput = (key, value) => editRange({ [key]: value });

  const playRange = (restart = false) => {
    const video = videoRef.current;
    if (!video) return;
    if (restart || video.currentTime < range.start || video.currentTime >= range.end - 0.05) video.currentTime = range.start;
    setRangePlaying(true);
    video.play().catch(() => setRangePlaying(false));
  };

  // Stop the preview at the end of the selected range.
  useEffect(() => {
    if (!rangePlaying) return undefined;
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.currentTime >= range.end) {
        video.pause();
        video.currentTime = range.end;
        setRangePlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rangePlaying, range.end]);

  // Only one player at a time.
  useEffect(() => {
    const players = [videoRef.current, resultVideoRef.current, musicRef.current].filter(Boolean);
    const onPlay = (e) => {
      for (const p of players) if (p !== e.currentTarget && !p.paused) p.pause();
    };
    players.forEach((p) => p.addEventListener('play', onPlay));
    return () => players.forEach((p) => p.removeEventListener('play', onPlay));
  }, [result, fileURL]);

  /** Toggle between result and original, keeping the same moment on screen. */
  const switchView = (next) => {
    const original = videoRef.current;
    const separated = resultVideoRef.current;
    if (!original || !separated || next === view) return;
    const offset = result?.report.range?.actualStart ?? 0;
    const [from, to] = next === 'result' ? [original, separated] : [separated, original];
    const wasPlaying = !from.paused;
    from.pause();
    const t = next === 'result' ? from.currentTime - offset : from.currentTime + offset;
    to.currentTime = clamp(t, 0, Number.isFinite(to.duration) ? to.duration : t);
    setView(next);
    if (wasPlaying) to.play().catch(() => {});
  };

  // ── separation ──
  const onModeChange = (next) => {
    if (busy || next === mode) return;
    setMode(next);
    clearResult();
  };

  const start = async () => {
    if (!file || busy || rangeError || !support.supported) return;
    const jobId = ++jobRef.current;
    pauseRange();
    clearResult();
    setError('');
    setCancelling(false);
    setPhase('progress');
    setProgress({ percent: 0, title: STAGE_TITLES.loading, message: '처리 도구를 준비하고 있어요.' });
    const separating = mode === 'vocals' ? '노랫소리와 반주를 나누고 있어요' : '음악과 장면의 소리를 나누고 있어요';
    const requested = range.useRange
      ? { start: range.start, end: Number.isFinite(duration) ? Math.min(range.end, duration) : range.end }
      : null;
    try {
      const out = await separateVideo(file, {
        mode,
        range: requested,
        onProgress: (p) => {
          if (jobId !== jobRef.current) return;
          setProgress({ percent: clamp(Number(p.percent) || 0, 0, 100), title: STAGE_TITLES[p.stage] || separating, message: p.message || '' });
        },
      });
      if (jobId !== jobRef.current) return;
      const saved = out.report.range;
      const suffix = saved ? `_${formatTime(saved.actualStart).replace(':', 'm')}s-${formatTime(saved.actualEnd).replace(':', 'm')}s` : '';
      const stem = (file.name.replace(/\.[^.]+$/, '') || 'video') + suffix;
      const vocals = mode === 'vocals';
      const videoURL = URL.createObjectURL(out.videoBlob);
      const musicURL = URL.createObjectURL(out.musicBlob);
      const cleanURL = URL.createObjectURL(out.cleanAudioBlob);
      setResult({
        mode,
        videoURL,
        musicURL,
        urls: [videoURL, musicURL, cleanURL],
        report: { ...out.report, mode },
        downloads: [
          { label: vocals ? '보컬 영상 받기' : '분리된 영상 받기', url: videoURL, fileName: `${stem}_${vocals ? '보컬분리' : '배경음악분리'}.${out.report.outputExtension}` },
          { label: vocals ? '반주만 받기 (WAV)' : '배경음악만 받기 (WAV)', url: musicURL, fileName: `${stem}_${vocals ? '반주' : '배경음악'}.wav` },
          { label: vocals ? '보컬만 받기 (WAV)' : '대사·효과음만 받기 (WAV)', url: cleanURL, fileName: `${stem}_${vocals ? '보컬' : '대사효과음'}.wav` },
        ],
      });
      setView('result');
      setPhase('result');
    } catch (err) {
      if (jobId !== jobRef.current) return;
      setPhase('setup');
      if (err?.name !== 'AbortError') setError(err?.message || '처리 중 문제가 생겼어요. 새로고침한 뒤 다시 시도해 주세요.');
    } finally {
      if (jobId === jobRef.current) setCancelling(false);
    }
  };

  const cancel = () => {
    if (!busy || cancelling) return;
    setCancelling(true);
    try { cancelSeparation(); } catch {}
  };

  useEffect(() => {
    if (!busy) return undefined;
    const warn = (e) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // ── drag & drop ──
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  useEffect(() => {
    const stop = (e) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
  const dropHandlers = {
    onDragEnter: (e) => { if (!busy && hasFiles(e)) { dragDepth.current += 1; setDragging(true); } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); },
    onDragOver: (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!busy) takeFiles(e.dataTransfer.files);
    },
  };

  const startNote = !support.supported
    ? support.reason
    : !file ? '먼저 영상을 선택해 주세요.'
    : rangeError || (range.useRange ? `선택한 ${formatTime(range.end - range.start)} 구간만 분리해요.` : '첫 실행에는 AI 모델(약 100MB)을 내려받아요.');
  const saved = result?.report.range;
  const resultSummary = saved
    ? `${formatTime(saved.actualStart)} → ${formatTime(saved.actualEnd)} 구간을 저장했어요. 원본과 비교해 보고 필요한 파일을 받으세요.`
    : '원본과 비교해 보고 필요한 파일을 받으세요.';

  return (
    <Box sx={pageStyle}>
      <Box as="header" sx={headerStyle}>
        <FlexBox sx={containerStyle} alignItems="center" justifyContent="space-between" style={{ height: '100%' }}>
          <FlexBox as="a" href="./" alignItems="center" gap="8px" aria-label="BGM OFF 처음으로" sx={{ color: 'inherit', textDecoration: 'none' }}>
            <Box sx={logoMarkStyle} aria-hidden="true">♪</Box>
            <Typography variant="headline1" weight="bold">BGM OFF</Typography>
          </FlexBox>
          <AboutModal />
        </FlexBox>
      </Box>

      <Box as="main" sx={containerStyle} style={{ paddingTop: '40px', paddingBottom: '64px' }}>
        <FlexBox flexDirection="column" gap="8px" style={{ marginBottom: '32px' }}>
          <Typography as="h1" variant="title2" weight="bold" xs={{ variant: 'title3' }} md={{ variant: 'title2' }}>
            배경음악 분리
          </Typography>
          <Typography variant="body2" color="semantic.label.alternative">
            영상에서 배경음악이나 보컬만 분리해요. 파일은 기기 밖으로 나가지 않아요.
          </Typography>
        </FlexBox>

        <Box sx={workbenchStyle(!file)}>
          <Box sx={cardStyle} {...dropHandlers}>
            <Box
              as="input"
              ref={inputRef}
              sx={hiddenInputStyle}
              type="file"
              tabIndex={-1}
              accept="video/*,.mp4,.mov,.webm,.mkv,.m4v"
              aria-hidden="true"
              onChange={(e) => { takeFiles(e.target.files); e.target.value = ''; }}
            />
            {!file ? (
              <DropZone dragging={dragging} disabled={busy} onPick={() => inputRef.current?.click()} />
            ) : (
              <FlexBox flexDirection="column" gap="20px">
                <FlexBox alignItems="center" justifyContent="space-between" gap="12px">
                  <FlexBox flexDirection="column" gap="2px" sx={{ minWidth: 0 }}>
                    <Typography variant="label1" weight="bold" noWrap title={file.name}>{file.name}</Typography>
                    <Typography variant="caption1" color="semantic.label.alternative">
                      {[formatSize(file.size), Number.isFinite(duration) ? formatClock(duration) : null].filter(Boolean).join(' · ')}
                    </Typography>
                  </FlexBox>
                  <TextButton color="assistive" size="small" disabled={busy} leadingContent={<IconRefresh />} onClick={resetFile}>
                    다른 영상
                  </TextButton>
                </FlexBox>

                {result && (
                  <SegmentedControl size="small" value={view} onValueChange={switchView}>
                    <SegmentedControlItem value="result">{result.mode === 'vocals' ? '보컬만 남긴 영상' : '배경음악 뺀 영상'}</SegmentedControlItem>
                    <SegmentedControlItem value="original">원본</SegmentedControlItem>
                  </SegmentedControl>
                )}

                <Box sx={videoStageStyle(ratio)} style={showResult ? { display: 'none' } : undefined}>
                  <video
                    ref={videoRef}
                    src={fileURL}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label="원본 영상"
                    onLoadedMetadata={onMetadata}
                    onDurationChange={onMetadata}
                    onPause={() => setRangePlaying(false)}
                    onError={() => setPreviewError(true)}
                  />
                  {previewError && (
                    <Box sx={overlayTextStyle}>
                      <Typography variant="label2" color="semantic.inverse.label">
                        이 형식은 브라우저에서 미리볼 수 없어요. 분리는 그대로 진행할 수 있어요.
                      </Typography>
                    </Box>
                  )}
                </Box>

                {result && (
                  <>
                    <Box sx={videoStageStyle(ratio)} style={showResult ? undefined : { display: 'none' }}>
                      <video ref={resultVideoRef} src={result.videoURL} controls playsInline preload="metadata" aria-label="분리된 영상" />
                    </Box>
                    <Box sx={audioRowStyle}>
                      <Typography variant="label2" weight="medium" sx={{ flex: 'none' }}>
                        {result.mode === 'vocals' ? '반주만' : '배경음악만'}
                      </Typography>
                      <audio ref={musicRef} src={result.musicURL} controls preload="metadata" />
                    </Box>
                  </>
                )}

                {result ? (
                  <ResultReport report={result.report} />
                ) : (
                  <RangeEditor
                    duration={duration}
                    useRange={range.useRange}
                    start={range.start}
                    end={range.end}
                    error={rangeError}
                    disabled={busy}
                    tooLong={tooLong}
                    autoRange={range.auto}
                    playing={rangePlaying}
                    onModeChange={onRangeMode}
                    onSliderChange={onSliderChange}
                    onTimeInput={onTimeInput}
                    onTogglePlay={() => (rangePlaying ? pauseRange() : playRange())}
                    onRestart={() => playRange(true)}
                  />
                )}
              </FlexBox>
            )}
          </Box>

          <ActionPanel
            phase={phase}
            mode={mode}
            onModeChange={onModeChange}
            canStart={!!file && !busy && !rangeError && support.supported}
            startNote={startNote}
            onStart={start}
            progress={progress}
            cancelling={cancelling}
            onCancel={cancel}
            downloads={result?.downloads || []}
            resultSummary={resultSummary}
            onReset={resetFile}
            error={error}
          />
        </Box>
      </Box>
    </Box>
  );
}
