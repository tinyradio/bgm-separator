import { css } from '@wanteddev/wds';

export const pageStyle = (theme) => css`
  min-height: 100vh;
  background-color: ${theme.semantic.background.normal.alternative};
`;

export const headerStyle = (theme) => css`
  height: 64px;
  background-color: ${theme.semantic.background.normal.normal};
  border-bottom: 1px solid ${theme.semantic.line.solid.normal};
`;

export const containerStyle = css`
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
  @media (max-width: 767px) {
    padding: 0 16px;
  }
`;

export const logoMarkStyle = (theme) => css`
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: ${theme.semantic.static.white};
  background-color: ${theme.semantic.primary.normal};
  font-size: 20px;
`;

/** `fill`: stretch both columns to the same height (empty state). */
export const workbenchStyle = (fill) => css`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 24px;
  align-items: ${fill ? 'stretch' : 'start'};
  & > :first-of-type {
    display: ${fill ? 'flex' : 'block'};
    flex-direction: column;
  }
  @media (max-width: 991px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

export const cardStyle = (theme) => css`
  min-width: 0;
  padding: 24px;
  background-color: ${theme.semantic.background.normal.normal};
  border: 1px solid ${theme.semantic.line.normal.neutral};
  border-radius: 16px;
  box-shadow: ${theme.semantic.elevation.shadow.normal.xsmall};
  @media (max-width: 767px) {
    padding: 20px 16px;
  }
`;

export const dropzoneStyle = (active) => (theme) => css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 8px;
  width: 100%;
  min-height: 360px;
  padding: 32px 16px;
  border: 1px dashed ${active ? theme.semantic.primary.normal : theme.semantic.line.normal.normal};
  border-radius: 12px;
  background-color: ${active ? theme.semantic.background.normal.normal : theme.semantic.background.normal.alternative};
  color: ${theme.semantic.label.normal};
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;
  &:hover {
    border-color: ${theme.semantic.primary.normal};
  }
  &:focus-visible {
    outline: 2px solid ${theme.semantic.primary.normal};
    outline-offset: 2px;
  }
  @media (max-width: 767px) {
    min-height: 240px;
  }
`;

export const uploadIconStyle = (theme) => css`
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: 8px;
  border-radius: 16px;
  color: ${theme.semantic.primary.normal};
  background-color: ${theme.semantic.fill.alternative};
  font-size: 28px;
`;

export const videoStageStyle = (ratio, highlight) => (theme) => css`
  position: relative;
  width: 100%;
  aspect-ratio: ${ratio || '16 / 9'};
  max-height: min(560px, 65vh);
  overflow: hidden;
  border-radius: 12px;
  background-color: ${theme.semantic.inverse.background};
  ${highlight ? `outline: 2px solid ${theme.semantic.primary.normal}; outline-offset: 2px;` : ''}
  & video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
`;

export const overlayTextStyle = css`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  pointer-events: none;
`;

export const sectionBoxStyle = (theme) => css`
  padding: 20px;
  border-radius: 12px;
  background-color: ${theme.semantic.background.normal.alternative};
  @media (max-width: 767px) {
    padding: 16px;
  }
`;

export const modeOptionStyle = (checked, disabled) => (theme) => css`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid ${checked ? theme.semantic.primary.normal : theme.semantic.line.normal.neutral};
  border-radius: 12px;
  background-color: ${theme.semantic.background.normal.normal};
  cursor: ${disabled ? 'default' : 'pointer'};
  opacity: ${disabled ? 0.6 : 1};
  transition: border-color 0.2s;
`;

export const audioRowStyle = (theme) => css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid ${theme.semantic.line.normal.neutral};
  border-radius: 12px;
  & audio {
    flex: 1;
    min-width: 0;
    height: 40px;
  }
`;

export const reportGridStyle = css`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin: 0;
  & dd {
    margin: 4px 0 0;
  }
  @media (max-width: 767px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
`;

export const warningListStyle = (theme) => css`
  margin: 0;
  padding-left: 20px;
  color: ${theme.semantic.label.alternative};
`;

export const hiddenInputStyle = css`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
`;

export const aboutListStyle = (theme) => css`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
  list-style: disc;
  color: ${theme.semantic.label.alternative};
`;
