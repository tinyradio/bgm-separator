import { useState } from 'react';
import {
  ActionArea,
  ActionAreaButton,
  Box,
  Modal,
  ModalContainer,
  ModalContent,
  ModalContentItem,
  ModalHeading,
  ModalNavigation,
  ModalTrigger,
  TextButton,
  Typography,
} from '@wanteddev/wds';
import { IconCircleInfo } from '@wanteddev/wds-icon';

import { aboutListStyle } from '../style';

const SECTIONS = [
  {
    title: '사용 방법',
    items: [
      '데스크톱 Chrome 또는 Edge에서 영상을 끌어놓고 분리 방식을 고른 뒤 분리 버튼을 누르세요.',
      '3분이 넘는 영상은 구간을 선택하세요. 슬라이더로 범위를 정하고 ‘구간 재생’으로 확인할 수 있어요.',
      '첫 사용에는 AI 모델을 내려받아요. 배경음 모드는 약 97MB, 뮤비 보컬은 약 67MB예요.',
    ],
  },
  {
    title: '분리 방식',
    items: [
      '배경음 약하게 — 두 모델(BandIt v2, TIGER-DnR)이 모두 음악이라고 본 소리만 지워요.',
      '배경음 중간 — 위 결과와 BandIt 결과를 절반씩 섞어요.',
      '배경음 세게 — BandIt 결과만 사용해 더 세게 지워요.',
      '뮤비 보컬 — UVR-MDX-NET으로 보컬과 반주를 나눠요.',
    ],
  },
  {
    title: '지원 범위',
    items: [
      '300MB 이하의 모노·스테레오 MP4·MOV·MKV·WebM 영상, 한 번에 최대 3분까지 분리해요.',
    ],
  },
  {
    title: '화질은 그대로예요',
    items: [
      '소리만 새로 만들고, 영상 화면은 다시 압축(재인코딩)하지 않고 원본 데이터를 그대로 복사해요. 그래서 화질 저하가 없고 처리도 빨라요.',
      '해상도·프레임레이트·프레임 수도 원본과 같아요. 전체 영상을 분리했다면 편집 툴에서 원본 클립과 바로 바꿔 써도 싱크가 맞아요.',
      '결과를 드리기 전에 영상 데이터가 원본과 똑같은지 자동으로 확인해요. 결과 화면의 ‘처리 정보’에서 확인 결과를 볼 수 있어요.',
      '구간을 선택하면 화질을 지키기 위해 시작·끝이 가까운 키프레임에 맞춰 조금 조정될 수 있어요.',
      '원본 그대로 저장할 수 없는 코덱이면 재압축하는 대신 안내해 드려요.',
    ],
  },
  {
    title: '개인정보',
    items: ['영상과 오디오는 브라우저 안에서만 처리되고 서버로 업로드되지 않아요.'],
  },
  {
    title: '모델 및 오픈소스',
    items: [
      'BandIt v2 — 코드 Apache-2.0, 가중치 CC BY-SA 4.0 (github.com/kwatcharasupat/bandit-v2). 브라우저용 ONNX 변환본도 CC BY-SA 4.0을 따릅니다.',
      'TIGER-DnR — 가중치 Apache-2.0, 구조 MIT',
      'UVR-MDX-NET-Voc_FT — MIT (github.com/TRvlvr/model_repo)',
      'ffmpeg.wasm — MIT(래퍼), FFmpeg LGPL/GPL · ONNX Runtime Web — MIT',
    ],
  },
];

export default function AboutModal() {
  const [open, setOpen] = useState(false);
  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger>
        <TextButton color="assistive" size="small" leadingContent={<IconCircleInfo />}>
          이용 안내
        </TextButton>
      </ModalTrigger>

      <ModalContainer variant="popup" size="large" xs={{ variant: 'bottom' }} sm={{ variant: 'popup' }}>
        <ModalNavigation>이용 안내</ModalNavigation>
        <ModalContent>
          {SECTIONS.map((section) => (
            <ModalContentItem key={section.title} flexDirection="column" gap="8px">
              <ModalHeading>{section.title}</ModalHeading>
              <Box as="ul" sx={aboutListStyle}>
                {section.items.map((item) => (
                  <li key={item}>
                    <Typography variant="body2" color="semantic.label.neutral">{item}</Typography>
                  </li>
                ))}
              </Box>
            </ModalContentItem>
          ))}
        </ModalContent>
        <ActionArea>
          <ActionAreaButton onClick={() => setOpen(false)}>확인</ActionAreaButton>
        </ActionArea>
      </ModalContainer>
    </Modal>
  );
}
