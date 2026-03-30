/**
 * Scoring constants for the Cerno behavioral analysis pipeline.
 * Single source of truth for all tunable parameters.
 *
 * These control the sensitivity curve of human/bot discrimination.
 * Change with care: each constant was calibrated against the adversarial eval.
 */

/** Gaussian dampening factor. Controls how quickly scores degrade with z-score distance.
 *  k=3: z=2 scores ~0.80, z=3 scores ~0.61. Standard 3-sigma tolerance for natural
 *  human variation. k=2 was too aggressive — calibrated against synthetic traces,
 *  caused false rejections on real users (especially mobile). */
export const GAUSSIAN_K = 3

/** Weight of public behavioral features in the blended score (0-1). K-H4: rebalanced from 0.7 */
export const PUBLIC_SCORE_WEIGHT = 0.6

/** Weight of secret server-only features in the blended score (0-1). K-H4: rebalanced from 0.3 */
export const SECRET_SCORE_WEIGHT = 0.4

/** Maximum score bonus from Stroop probe performance. */
export const PROBE_BONUS_MAX = 0.05

/** Maximum events accepted per submission (DoS boundary). */
export const MAX_EVENTS = 50_000

/** Z-score threshold above which a single feature triggers the extreme outlier penalty. */
export const EXTREME_OUTLIER_Z = 4

/** Score penalty multiplier per cross-feature anomaly detected. */
export const ANOMALY_PENALTY_PER = 0.15

/** Minimum sample count below which a linear penalty is applied. */
export const MIN_SAMPLE_COUNT = 20

/** Minimum solve duration (ms) below which a linear penalty is applied. */
export const MIN_DURATION_MS = 2000

// ── Path efficiency baseline multipliers ──
/** Human path efficiency as fraction of BFS optimal. */
export const PATH_EFFICIENCY_MEAN_RATIO = 0.9
/** Std dev of path efficiency as fraction of BFS optimal. */
export const PATH_EFFICIENCY_STD_RATIO = 0.15

// ── Pause count baseline multipliers ──
/** Human pauses per decision point in the maze. */
export const PAUSE_PER_DECISION_POINT = 1.5
/** Minimum expected pause count (straight corridors). */
export const PAUSE_COUNT_MIN_MEAN = 2
/** Std dev of pause count per decision point. */
export const PAUSE_STD_PER_DECISION_POINT = 0.6
/** Minimum pause count std. */
export const PAUSE_COUNT_MIN_STD = 1.5

// ── Angular entropy baseline ──
/** Base angular velocity entropy for axis-aligned maze paths. */
export const ANGULAR_ENTROPY_BASE = 0.8
/** Additional entropy per turn in the solution path. */
export const ANGULAR_ENTROPY_PER_TURN = 0.08
/** Maximum angular velocity entropy (cap). */
export const ANGULAR_ENTROPY_MAX = 3.5

// ── Secret feature constants ──
/** Micro-correction angle threshold in radians (~15 degrees). */
export const MICRO_CORRECTION_ANGLE_RAD = 0.26
/** Minimum velocity peak height to count as sub-movement. */
export const VELOCITY_PEAK_THRESHOLD = 0.0001
