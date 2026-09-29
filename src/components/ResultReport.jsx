import { Box, FlexBox, Typography } from '@wanteddev/wds';

import { formatClock, formatTime } from '../format';
import { reportGridStyle, sectionBoxStyle, warningListStyle } from '../style';

const MODE_LABEL = {
  dialogue: '대사 · 효과음 (약하게)',
  medium: '대사 · 효과음 (중간)',
  strong: '대사 · 효과음 (세게)',
  vocals: '뮤비 보컬',
};

export default function ResultReport({ report }) {
  const rows = [['남긴 소리', MODE_LABEL[report.mode]]];
  if (Number.isFinite(report.range?.actualStart)) {
    rows.push(['저장된 구간', `${formatTime(report.range.actualStart)} → ${formatTime(report.range.actualEnd)}`]);
  }
  if (report.width && report.height) rows.push(['해상도', `${report.width} × ${report.height}`]);
  if (report.fps) rows.push(['프레임레이트', `${Number(Number(report.fps).toFixed(3))} fps`]);
  if (report.frameCount) rows.push(['프레임 수', `${Number(report.frameCount).toLocaleString('ko-KR')}개`]);
  rows.push(['원본 영상 데이터', report.videoVerified ? '일치 확인' : '확인 필요']);
  rows.push(['처리 방식', report.separationBackend === 'webgpu' ? 'GPU 가속' : '기본 처리']);
  if (Number.isFinite(report.elapsedSeconds)) rows.push(['처리 시간', formatClock(report.elapsedSeconds)]);
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];

  return (
    <Box sx={sectionBoxStyle}>
      <FlexBox flexDirection="column" gap="16px">
        <FlexBox flexDirection="column" gap="4px">
          <Typography variant="headline2" weight="bold">처리 정보</Typography>
          <Typography variant="label2" color="semantic.label.alternative">
            영상 화면은 재압축 없이 원본 그대로 복사하고, 결과 파일의 영상 데이터가 원본과 같은지 확인했어요.
          </Typography>
        </FlexBox>
        <Box as="dl" sx={reportGridStyle}>
          {rows.map(([k, v]) => (
            <div key={k}>
              <Typography as="dt" variant="caption1" color="semantic.label.alternative">{k}</Typography>
              <Typography as="dd" variant="label1" weight="medium">{v}</Typography>
            </div>
          ))}
        </Box>
        {warnings.length > 0 && (
          <Box as="ul" sx={warningListStyle}>
            {warnings.map((w) => (
              <li key={w}><Typography variant="caption1" color="semantic.label.alternative">{w}</Typography></li>
            ))}
          </Box>
        )}
      </FlexBox>
    </Box>
  );
}
