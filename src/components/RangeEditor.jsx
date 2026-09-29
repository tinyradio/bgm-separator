import { Box, Button, FlexBox, SegmentedControl, SegmentedControlItem, Slider, TextField, Typography } from '@wanteddev/wds';
import { IconPause, IconPlay, IconRefresh } from '@wanteddev/wds-icon';

import { formatTime, parseTime } from '../format';
import { sectionBoxStyle } from '../style';

export default function RangeEditor({
  duration,
  useRange,
  start,
  end,
  error,
  disabled,
  tooLong,
  autoRange,
  playing,
  onModeChange,
  onSliderChange,
  onTimeInput,
  onTogglePlay,
  onRestart,
}) {
  const known = Number.isFinite(duration) && duration > 0;
  const note = !known
    ? '미리보기를 지원하지 않는 영상은 시작·끝 시간을 직접 입력해 주세요. 예: 1:05.5 또는 65.5'
    : tooLong
      ? autoRange
        ? '긴 영상이라 처음 30초를 선택했어요. 원하는 구간으로 옮겨 주세요.'
        : '3분이 넘는 영상은 구간을 선택해 주세요.'
      : '';

  return (
    <Box sx={sectionBoxStyle}>
      <FlexBox flexDirection="column" gap="16px">
        <FlexBox alignItems="center" justifyContent="space-between" gap="12px" flexWrap="wrap">
          <Typography variant="headline2" weight="bold">분리 구간</Typography>
          <SegmentedControl size="small" value={useRange ? 'selected' : 'full'} onValueChange={onModeChange}>
            <SegmentedControlItem value="full" disabled={disabled || tooLong}>전체 영상</SegmentedControlItem>
            <SegmentedControlItem value="selected" disabled={disabled}>구간 선택</SegmentedControlItem>
          </SegmentedControl>
        </FlexBox>

        {useRange && known && (
          <FlexBox flexDirection="column" gap="16px">
            <Slider
              min={0}
              max={duration}
              step={0.1}
              value={[start, end]}
              disabled={disabled}
              disableSwapThumbs
              minStepBetweenThumbs={0.1}
              onValueChange={onSliderChange}
              label={({ value }) => formatTime(value)}
            />
            <FlexBox gap="8px" alignItems="center">
              <Button
                size="small"
                variant="outlined"
                color="assistive"
                disabled={disabled}
                leadingContent={playing ? <IconPause /> : <IconPlay />}
                onClick={onTogglePlay}
              >
                {playing ? '일시정지' : '구간 재생'}
              </Button>
              <Button size="small" variant="outlined" color="assistive" disabled={disabled} leadingContent={<IconRefresh />} onClick={onRestart}>
                처음부터
              </Button>
            </FlexBox>
          </FlexBox>
        )}

        {useRange && !known && (
          <FlexBox gap="12px" xs={{ flexDirection: 'column' }} sm={{ flexDirection: 'row' }}>
            {[['start', '시작', start], ['end', '끝', end]].map(([key, label, value]) => (
              <FlexBox key={key} flexDirection="column" gap="8px" flex="1">
                <Typography as="label" htmlFor={`range-${key}`} variant="label1" weight="medium" color="semantic.label.neutral">{label}</Typography>
                <TextField
                  id={`range-${key}`}
                  defaultValue={formatTime(value)}
                  invalid={!!error}
                  disabled={disabled}
                  onChange={(e) => onTimeInput(key, parseTime(e.target.value))}
                />
              </FlexBox>
            ))}
          </FlexBox>
        )}

        <Typography variant="label2" color={error ? 'semantic.status.negative' : 'semantic.label.alternative'}>
          {error ||
            (useRange
              ? `${formatTime(start)} → ${formatTime(end)} · ${formatTime(end - start)} 분리 · 화질 유지를 위해 경계가 조금 조정될 수 있어요`
              : known ? `전체 ${formatTime(duration)} 분리` : '')}
        </Typography>
        {note && <Typography variant="label2" color="semantic.label.alternative">{note}</Typography>}
      </FlexBox>
    </Box>
  );
}
