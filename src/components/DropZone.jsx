import { Box, Typography } from '@wanteddev/wds';
import { IconUpload } from '@wanteddev/wds-icon';

import { dropzoneStyle, uploadIconStyle } from '../style';

export default function DropZone({ dragging, disabled, onPick }) {
  return (
    <Box as="button" type="button" disabled={disabled} onClick={onPick} sx={dropzoneStyle(dragging)}>
      <Box sx={uploadIconStyle}>
        <IconUpload />
      </Box>
      <Typography variant="headline1" weight="bold" align="center">
        {dragging ? '여기에 놓으면 준비돼요' : '영상을 끌어놓거나 선택하세요'}
      </Typography>
      <Typography variant="label2" align="center" color="semantic.label.alternative">
        MP4 · MOV · WebM · MKV
        <br />
        최대 300MB · 한 번에 3분까지
      </Typography>
    </Box>
  );
}
