// The sonar widgets' colour palettes and how they colour a byte of echo strength, apart from
// SonarColorOptions.vue so code outside Vue, like the Ping360 on Cockpit's map, colours the same

export interface PaletteStop {
  // 0..1 along the echo strength
  pos: number;
  // RGBA 0..255
  color: number[];
}

export type Gradient = PaletteStop[];

export const DEFAULT_PALETTE = 'Thermal Blue';
// where SonarColorOptions saves the Custom palette
export const CUSTOM_PALETTE_KEY = 'customColorPalette';

export const colorPalettes: Record<string, Gradient> = {
  Transparent: [
    { pos: 0, color: [255, 255, 255, 0] },
    { pos: 1, color: [255, 255, 255, 255] },
  ],
  Heatmap: [
    { pos: 0, color: [0, 0, 0, 255] },
    { pos: 0.25, color: [255, 0, 0, 255] },
    { pos: 0.5, color: [255, 255, 0, 255] },
    { pos: 0.75, color: [255, 255, 255, 255] },
    { pos: 1, color: [255, 255, 255, 255] },
  ],
  Grayscale: [
    { pos: 0, color: [0, 0, 0, 255] },
    { pos: 1, color: [255, 255, 255, 255] },
  ],
  Ocean: [
    { pos: 0, color: [0, 0, 60, 255] },
    { pos: 0.5, color: [0, 63, 255, 255] },
    { pos: 1, color: [0, 255, 255, 255] },
  ],
  'Thermal Blue': [
    { pos: 0, color: [5, 34, 95, 255] },
    { pos: 0.25, color: [106, 168, 79, 255] },
    { pos: 0.5, color: [255, 255, 0, 255] },
    { pos: 0.75, color: [127, 96, 0, 255] },
    { pos: 1, color: [92, 15, 8, 255] },
  ],
  'Thermal Black': [
    { pos: 0, color: [0, 0, 0, 255] },
    { pos: 0.25, color: [106, 168, 79, 255] },
    { pos: 0.5, color: [255, 255, 0, 255] },
    { pos: 0.75, color: [127, 96, 0, 255] },
    { pos: 1, color: [92, 15, 8, 255] },
  ],
  'Thermal White': [
    { pos: 0, color: [255, 255, 255, 255] },
    { pos: 0.25, color: [106, 168, 79, 255] },
    { pos: 0.5, color: [255, 255, 0, 255] },
    { pos: 0.75, color: [127, 96, 0, 255] },
    { pos: 1, color: [92, 15, 8, 255] },
  ],
  'Monochrome Black': [
    { pos: 0, color: [0, 0, 0, 255] },
    { pos: 1, color: [255, 255, 255, 255] },
  ],
  'Monochrome White': [
    { pos: 0, color: [255, 255, 255, 255] },
    { pos: 1, color: [0, 0, 0, 255] },
  ],
  'Monochrome Sepia': [
    { pos: 0, color: [48, 33, 19, 255] },
    { pos: 1, color: [232, 201, 67, 255] },
  ],
  Custom: [],
};

// The RGBA of a byte of echo strength, 0..255, along `gradient`
export const colorFromGradient = (value: number, gradient: Gradient): number[] => {
  const intensity = value / 255;
  for (let i = 1; i < gradient.length; i++) {
    if (intensity <= gradient[i].pos) {
      const t = (intensity - gradient[i - 1].pos) / (gradient[i].pos - gradient[i - 1].pos);
      const c1 = gradient[i - 1].color;
      const c2 = gradient[i].color;
      return [
        Math.round(c1[0] + t * (c2[0] - c1[0])),
        Math.round(c1[1] + t * (c2[1] - c1[1])),
        Math.round(c1[2] + t * (c2[2] - c1[2])),
        Math.round(c1[3] + t * (c2[3] - c1[3])),
      ];
    }
  }
  return gradient[gradient.length - 1].color;
};

export const getColorFromPalette = (value: number, palette: string): number[] =>
  colorFromGradient(value, colorPalettes[palette] || colorPalettes[DEFAULT_PALETTE]);

const isChannel = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255;

const isStop = (stop: unknown): stop is PaletteStop => {
  const { pos, color } = (stop ?? {}) as Partial<PaletteStop>;
  return (
    typeof pos === 'number' &&
    Number.isFinite(pos) &&
    Array.isArray(color) &&
    color.length >= 3 &&
    color.every(isChannel)
  );
};

// The Custom palette SonarColorOptions saved in `storage`, localStorage unless given, or
// undefined without a usable one
export const savedCustomPalette = (storage?: Pick<Storage, 'getItem'>): Gradient | undefined => {
  try {
    const saved = JSON.parse(
      (storage ?? globalThis.localStorage)?.getItem(CUSTOM_PALETTE_KEY) ?? 'null'
    );
    return Array.isArray(saved) && saved.length > 0 && saved.every(isStop) ? saved : undefined;
  } catch {
    return undefined;
  }
};

// The gradient a widget draws palette `name` with: Custom as saved and an unknown name as
// DEFAULT_PALETTE, as getColorFromPalette() does; undefined without a name or a usable Custom
export const paletteGradient = (
  name: string | undefined,
  storage?: Pick<Storage, 'getItem'>
): Gradient | undefined => {
  if (!name) return undefined;
  if (name === 'Custom') return savedCustomPalette(storage);
  return colorPalettes[name] || colorPalettes[DEFAULT_PALETTE];
};
