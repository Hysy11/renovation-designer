// 风格预设（方案 6.7 节表格）。M5 时对照画面再微调。
import type { Style } from '../model/schema';

export const STYLE_PRESETS: Record<'cozy-light-wood' | 'mid-century-minimal', { name: string; style: Style }> = {
  'cozy-light-wood': {
    name: '温馨浅木',
    style: {
      presetId: 'cozy-light-wood',
      palette: {
        wallColor: '#F3ECE0',
        primary: '#EFE6D6',
        secondary: '#E4DCCB',
        woodColor: '#D6B48A',
        fabricColor: '#E6D9C3',
        metalColor: '#BFA67A',
        accent: '#8FA98A',
      },
      floor: { material: 'wood-floor', color: '#D9BC94' },
      lighting: { colorTemp: 3500, intensity: 1.0 },
    },
  },
  'mid-century-minimal': {
    name: '简约中古风',
    style: {
      presetId: 'mid-century-minimal',
      palette: {
        wallColor: '#F7F5F0',
        primary: '#F4F2ED',
        secondary: '#E2DDD3',
        woodColor: '#6B4A33',
        fabricColor: '#D8D1C4',
        metalColor: '#2F2F2F',
        accent: '#8C6A3F',
      },
      floor: { material: 'wood-floor', color: '#C8A47C' },
      lighting: { colorTemp: 4000, intensity: 1.0 },
    },
  },
};

export const DEFAULT_PRESET = 'cozy-light-wood' as const;
