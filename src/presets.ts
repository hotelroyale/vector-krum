// Engine presets: one parameter set per image type and quality.

export type ImageType = 'logo' | 'logo_aa' | 'photo';
export type Quality = 0 | 1 | 2;

export interface PhaseSettings {
  enabled: boolean;
  /** 0 = tether nodes to their pixel-grid positions, 1 = generative (render & compare) model. */
  measurement: 0 | 1;
  priorStrength: number;
  lengthPenalty: number;
  punctureCorners: boolean;
  maxIter: number;
  minIter: number;
  relTol: number;
}

export interface Preset {
  isAntiAliased: boolean;
  reduceNoiseOrder: number;
  palette: { costPerColor: number; edgeWeightScale: number; edgeWeightFloor: number };
  segmenter: {
    maxIterations: number;
    lambdaInitial: number;
    lambdaFinal: number;
    riseFraction: number;
    minNumPixels: number;
    sizePenaltyWeight: number;
    sizePenaltyPower: number;
  };
  subPixel: {
    lambdaF: number;
    selfWeightEps: number;
    selfWeightPenaltyLow: number;
    selfWeightPenaltyHigh: number;
    colorClusterMargin: number;
  };
  smoother: {
    phases: [PhaseSettings, PhaseSettings, PhaseSettings];
    punctureFlatnessThresh: number;
    punctureCornerThresh: number;
    maxStepSize: number;
  };
  bezier: { maxIterations: number; statThreshInitial: number; statThreshFinal: number };
}

interface Row {
  aa: 0 | 1;
  noise: number;
  segIter: number;
  lambdaInitial: number;
  lambdaFinal: number;
  minPixels: number;
  measurement: 0 | 1;
  prior: number[];
  length: number[];
  puncture: number[];
  enabled: number[];
  maxIter: number[];
  relTol2: number;
  flatness: number;
  corner: number;
  bezIter: number;
  bezInit: number;
  bezFinal: number;
}

const ROWS: Record<string, Row> = {
  'logo 0': { aa: 0, noise: 0, segIter: 50, lambdaInitial: 1e-4, lambdaFinal: 1, minPixels: 4, measurement: 0, prior: [20, 20, 20], length: [5, 0.5, 0.1], puncture: [0, 1, 0], enabled: [1, 1, 1], maxIter: [30, 200, 500], relTol2: 1e-5, flatness: 0.2, corner: 1.2, bezIter: 20, bezInit: 1e-8, bezFinal: 0.7 },
  'logo 1': { aa: 0, noise: 0, segIter: 50, lambdaInitial: 1e-4, lambdaFinal: 0.5, minPixels: 4, measurement: 0, prior: [10, 10, 20], length: [5, 0.5, 0.1], puncture: [0, 1, 0], enabled: [1, 1, 1], maxIter: [30, 200, 500], relTol2: 1e-5, flatness: 0.2, corner: 1.2, bezIter: 20, bezInit: 1e-8, bezFinal: 0.6 },
  'logo 2': { aa: 0, noise: 0, segIter: 50, lambdaInitial: 1e-4, lambdaFinal: 0.1, minPixels: 3, measurement: 0, prior: [10, 10, 20], length: [5, 0.5, 0.1], puncture: [0, 1, 0], enabled: [1, 1, 1], maxIter: [30, 200, 500], relTol2: 1e-5, flatness: 0.2, corner: 1.2, bezIter: 20, bezInit: 1e-8, bezFinal: 0.5 },
  'logo_aa 0': { aa: 1, noise: 2, segIter: 50, lambdaInitial: 1e-4, lambdaFinal: 1, minPixels: 0, measurement: 1, prior: [5, 5, 5], length: [5, 0.5, 0.5], puncture: [0, 1, 0], enabled: [1, 1, 1], maxIter: [30, 225, 300], relTol2: 2e-5, flatness: 0.4, corner: 1, bezIter: 20, bezInit: 1e-8, bezFinal: 0.2 },
  'logo_aa 1': { aa: 1, noise: 1, segIter: 50, lambdaInitial: 1e-4, lambdaFinal: 0.5, minPixels: 0, measurement: 1, prior: [1, 1, 1], length: [5, 0.5, 0.5], puncture: [0, 1, 0], enabled: [1, 1, 1], maxIter: [30, 225, 300], relTol2: 2e-5, flatness: 0.4, corner: 1, bezIter: 20, bezInit: 1e-8, bezFinal: 0.2 },
  'logo_aa 2': { aa: 1, noise: 0, segIter: 50, lambdaInitial: 1e-4, lambdaFinal: 0.1, minPixels: 0, measurement: 1, prior: [0.1, 0.02, 0.9], length: [0.5, 0.1, 0.01], puncture: [0, 1, 0], enabled: [1, 1, 1], maxIter: [30, 225, 300], relTol2: 2e-5, flatness: 0.4, corner: 0.5, bezIter: 20, bezInit: 1e-8, bezFinal: 0.2 },
  'photo 0': { aa: 0, noise: 3, segIter: 100, lambdaInitial: 1e-3, lambdaFinal: 10, minPixels: 2, measurement: 0, prior: [5, 1, 1], length: [0.5, 0.5, 0.5], puncture: [0, 0, 0], enabled: [1, 0, 0], maxIter: [200, 200, 200], relTol2: 1e-5, flatness: 0.2, corner: 1.2, bezIter: 10, bezInit: 1e-4, bezFinal: 10 },
  'photo 1': { aa: 0, noise: 2, segIter: 75, lambdaInitial: 1e-3, lambdaFinal: 1, minPixels: 4, measurement: 0, prior: [2, 1, 1], length: [0.5, 0.5, 0.5], puncture: [0, 0, 0], enabled: [1, 0, 0], maxIter: [200, 200, 200], relTol2: 1e-5, flatness: 0.2, corner: 1.2, bezIter: 10, bezInit: 1e-4, bezFinal: 3 },
  'photo 2': { aa: 0, noise: 1, segIter: 50, lambdaInitial: 1e-3, lambdaFinal: 0.1, minPixels: 7, measurement: 0, prior: [1, 1, 1], length: [0.5, 0.5, 0.5], puncture: [0, 1, 0], enabled: [1, 0, 0], maxIter: [200, 200, 200], relTol2: 1e-5, flatness: 0.2, corner: 1.2, bezIter: 10, bezInit: 1e-4, bezFinal: 0.5 },
};

const MIN_ITER = [10, 50, 20];

export function getPreset(type: ImageType, quality: Quality): Preset {
  const r = ROWS[`${type} ${quality}`];
  const phase = (i: number): PhaseSettings => ({
    enabled: r.enabled[i] === 1,
    measurement: r.measurement,
    priorStrength: r.prior[i],
    lengthPenalty: r.length[i],
    punctureCorners: r.puncture[i] === 1,
    maxIter: r.maxIter[i],
    minIter: Math.min(MIN_ITER[i], r.maxIter[i]),
    relTol: i === 2 ? r.relTol2 : 1e-5,
  });
  return {
    isAntiAliased: r.aa === 1,
    reduceNoiseOrder: r.noise,
    palette: { costPerColor: 0.15, edgeWeightScale: 42, edgeWeightFloor: 0.0032 },
    segmenter: {
      maxIterations: r.segIter,
      lambdaInitial: r.lambdaInitial,
      lambdaFinal: r.lambdaFinal,
      riseFraction: 0.4,
      minNumPixels: r.minPixels,
      sizePenaltyWeight: 0,
      sizePenaltyPower: 1,
    },
    subPixel: {
      lambdaF: 0.1,
      selfWeightEps: 0.1,
      selfWeightPenaltyLow: 0.01,
      selfWeightPenaltyHigh: 1,
      colorClusterMargin: 0.1,
    },
    smoother: {
      phases: [phase(0), phase(1), phase(2)],
      punctureFlatnessThresh: r.flatness,
      punctureCornerThresh: r.corner,
      maxStepSize: 0.3,
    },
    bezier: { maxIterations: r.bezIter, statThreshInitial: r.bezInit, statThreshFinal: r.bezFinal },
  };
}
