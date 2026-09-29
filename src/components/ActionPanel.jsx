import {
  Box,
  Button,
  ContentBadge,
  Divider,
  FlexBox,
  ProgressIndicator,
  RadioGroup,
  RadioGroupItem,
  SectionMessage,
  TextButton,
  Typography,
} from '@wanteddev/wds';
import { IconArrowRight, IconCircleCheckFill, IconDownload, IconRefresh } from '@wanteddev/wds-icon';

import { cardStyle, modeOptionStyle } from '../style';

const MODES = [
  { value: 'dialogue', title: '배경음 약하게', caption: '효과음 우선. 배경음이 조금 남을 수 있어요.' },
  { value: 'medium', title: '배경음 중간', caption: '배경음은 더 지우고 효과음은 대부분 남겨요.', recommended: true },
  { value: 'strong', title: '배경음 세게', caption: '잘 안 지워질 때. 효과음 일부도 지워질 수 있어요.' },
  { value: 'vocals', title: '뮤비 보컬', caption: '노랫소리와 반주를 나눠요.' },
];

function ModeSelect({ mode, disabled, onChange }) {
  return (
    <FlexBox flexDirection="column" gap="12px">
      <Typography variant="headline2" weight="bold">분리 방식</Typography>
      <RadioGroup value={mode} onValueChange={onChange} disabled={disabled} aria-label="분리 방식">
        <FlexBox flexDirection="column" gap="8px">
          {MODES.map((m) => (
            <Box as="label" key={m.value} sx={modeOptionStyle(mode === m.value, disabled)}>
              <RadioGroupItem value={m.value} size="small" tight />
              <FlexBox flexDirection="column" gap="2px">
                <FlexBox alignItems="center" gap="6px">
                  <Typography variant="label1" weight="bold">{m.title}</Typography>
                  {m.recommended && <ContentBadge size="xsmall" color="accent" accentColor="semantic.primary.normal">추천</ContentBadge>}
                </FlexBox>
                <Typography variant="caption1" color="semantic.label.alternative">{m.caption}</Typography>
              </FlexBox>
            </Box>
          ))}
        </FlexBox>
      </RadioGroup>
    </FlexBox>
  );
}

export default function ActionPanel({
  phase,
  mode,
  onModeChange,
  canStart,
  startNote,
  onStart,
  progress,
  cancelling,
  onCancel,
  downloads,
  resultSummary,
  onReset,
  error,
}) {
  const vocals = mode === 'vocals';
  return (
    <Box sx={cardStyle}>
      <FlexBox flexDirection="column" gap="24px">
        <ModeSelect mode={mode} disabled={phase === 'progress'} onChange={onModeChange} />
        <Divider color="semantic.line.normal.alternative" />

        {error && <SectionMessage variant="negative" description={error} />}

        {phase === 'setup' && (
          <FlexBox flexDirection="column" gap="12px">
            <Button size="large" fullWidth disabled={!canStart} trailingContent={<IconArrowRight />} onClick={onStart}>
              {vocals ? '보컬과 반주 분리하기' : '배경음악 분리하기'}
            </Button>
            <Typography variant="caption1" align="center" color="semantic.label.alternative">{startNote}</Typography>
          </FlexBox>
        )}

        {phase === 'progress' && (
          <FlexBox flexDirection="column" gap="12px" role="status" aria-live="polite">
            <FlexBox alignItems="baseline" justifyContent="space-between">
              <Typography variant="label1" weight="bold">{cancelling ? '작업을 취소하고 있어요' : progress.title}</Typography>
              <Typography variant="title3" weight="bold" color="semantic.primary.normal">{Math.floor(progress.percent)}%</Typography>
            </FlexBox>
            <ProgressIndicator percent={progress.percent} />
            <Typography variant="caption1" color="semantic.label.alternative">
              {cancelling ? '진행 중인 처리를 정리하고 있어요.' : progress.message}
            </Typography>
            <Typography variant="caption1" color="semantic.label.assistive">
              처리 중에는 탭을 열어두세요. 첫 실행에는 모델을 내려받아 시간이 더 걸려요.
            </Typography>
            <Button variant="outlined" color="assistive" fullWidth disabled={cancelling} onClick={onCancel}>
              {cancelling ? '취소하는 중…' : '작업 취소'}
            </Button>
          </FlexBox>
        )}

        {phase === 'result' && (
          <FlexBox flexDirection="column" gap="16px">
            <FlexBox alignItems="center" gap="8px">
              <Typography color="semantic.status.positive" sx={{ display: 'flex', fontSize: '24px' }}><IconCircleCheckFill /></Typography>
              <Typography variant="headline1" weight="bold">분리가 끝났어요</Typography>
            </FlexBox>
            <Typography variant="label2" color="semantic.label.alternative">{resultSummary}</Typography>
            <FlexBox flexDirection="column" gap="8px">
              {downloads.map((d, i) => (
                <Button
                  key={d.label}
                  as="a"
                  href={d.url}
                  download={d.fileName}
                  fullWidth
                  variant={i === 0 ? 'solid' : 'outlined'}
                  color={i === 0 ? 'primary' : 'assistive'}
                  leadingContent={<IconDownload />}
                >
                  {d.label}
                </Button>
              ))}
            </FlexBox>
            <TextButton color="assistive" size="small" leadingContent={<IconRefresh />} onClick={onReset} sx={{ alignSelf: 'center' }}>
              다른 영상 작업하기
            </TextButton>
          </FlexBox>
        )}

        <Typography variant="caption1" color="semantic.label.assistive">
          {vocals
            ? '보컬에 반주나 잔향이 일부 남을 수 있어요. 결과를 꼭 들어보세요.'
            : '소리가 겹친 구간은 음악이 일부 남거나 효과음이 달라질 수 있어요. 결과를 꼭 들어보세요.'}
        </Typography>
      </FlexBox>
    </Box>
  );
}
