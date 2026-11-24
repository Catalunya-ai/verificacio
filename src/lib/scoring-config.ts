/**
 * Menjometre Scoring Configuration — Single Source of Truth
 *
 * ALL scoring weights, thresholds, and version info live here.
 * Any script that computes scores MUST import from this file.
 *
 * Version history:
 *   v1 (2026-03): Equal weight (25% each), 4 components
 *   v2 (2026-03): Weighted (40/30/20/10), accountability with 6 signals incl. grant dependency
 *   v3 (2026-03-26): Accountability redesigned — hybrid model, 5 transparency signals,
 *                     scope narrowed to G-prefix obligated + voluntary filers
 *   v4 (2026-03-27): Concurrència scoring component added
 *   v5 (2026-03-28): Equal weights across all active components (volume + frequency + dominance
 *                     + concurrència + accountability) / number_of_active_components
 *                     Formula: (V + F + D + COALESCE(C,0) + COALESCE(A,0)) / (3 + has_C + has_A)
 *                     Implemented in calculate-scores-sql.ts step 5. MAIN_WEIGHTS below are
 *                     @deprecated and not used by the SQL script.
 *   v5.1 (2026-05-19): Low-N robustness floors. Frequency + Dominance require
 *                     total_public_funds ≥100K (resp. entity_purpose_amount ≥100K).
 *                     Concurrència excludes contracte menor under LCSP art.118 legal
 *                     thresholds (Obres <40K, Serveis/Subministraments <15K) and
 *                     requires classifiable_amount ≥25K. All 5 components now optional.
 */

// ============================================================
// Version
// ============================================================

// 2026-04-13: total_public_funds now includes accio_concertada (affects volume component).
// Scoring threshold NOT expanded for accio_concertada-only entities.
// 2026-05-19: v5.1 adds low-N floors to frequency/dominance/concurrència.
export const SCORING_VERSION = "v5.1";
export const SCORING_DATE = "2026-05-19";

/** v5.1: low-N robustness floor for frequency + dominance (entity-level) */
export const ROBUSTNESS_FLOOR = {
  /** Frequency: entity total_public_funds floor */
  frequencyMinPublicFunds: 100_000,
  /** Dominance: entity's primary purpose/CPV amount floor */
  dominanceMinPurposeAmount: 100_000,
  /** Concurrència: classifiable contract amount floor (after LCSP-menor exclusion) */
  concurrenciaMinClassifiableAmount: 25_000,
} as const;

/** v5.1: LCSP art. 118 minor-contract legal thresholds (no tender required below these) */
export const LCSP_MENOR_THRESHOLD = {
  obres: 40_000,
  serveisSubministraments: 15_000,
} as const;

/**
 * Fragmentation: the band immediately under the serveis/subministraments cap,
 * and how many contracts have to sit in it before the shape is worth counting.
 *
 * `analyze-contract-network.ts` reads the band to fill
 * `entities.fragmentation_count` and `fragmentation_risk`, which feed the
 * concurrència component, and METODOLOGIA.md states it in public. A test
 * (tests/unit/fragmentation-band.test.ts) pins the methodology text to these
 * constants, so a change has to move both.
 *
 * The top of the band is `LCSP_MENOR_THRESHOLD.serveisSubministraments` today,
 * written out rather than derived on purpose: if the legal cap ever moves, the
 * band for contracts already awarded under the old one must not move with it.
 */
export const FRAGMENTATION_BAND_MIN_EUR = 14_900;
export const FRAGMENTATION_BAND_MAX_EUR = 15_000;
export const FRAGMENTATION_MIN_CONTRACTS = 3;

// ============================================================
// Final Score Composition (menjometre_score)
// ============================================================

/**
 * @deprecated v5 uses equal-weight SQL formula in calculate-scores-sql.ts (step 5).
 * No script currently imports these weights. Kept for historical reference only.
 */
export const MAIN_WEIGHTS = {
  volume: 0.40,
  frequency: 0.30,
  dominance: 0.20,
  accountability: 0.10,
  // concurrencia added in v4, folded into equal-weight formula in v5
} as const;

/**
 * @deprecated v5 uses equal-weight SQL formula in calculate-scores-sql.ts (step 5).
 * No script currently imports these weights. Kept for historical reference only.
 */
export const MAIN_WEIGHTS_NO_ACCOUNTABILITY = {
  volume: 0.40 / 0.90,      // ≈ 0.4444
  frequency: 0.30 / 0.90,   // ≈ 0.3333
  dominance: 0.20 / 0.90,   // ≈ 0.2222
} as const;

// ============================================================
// Scoring Thresholds
// ============================================================

/** Minimum to be scored at all */
export const SCORING_THRESHOLD = {
  minTransactions: 1,          // grants + contracts
  minPublicFunds: 25_000,     // EUR total_public_funds
} as const;

// ============================================================
// Accountability Sub-Signals (transparency component)
// ============================================================

export const ACCOUNTABILITY_WEIGHTS = {
  filesAccounts: 0.35,       // Binary: any REJC filing
  filingRecency: 0.20,       // Gap ≤2yr = 100, ≤3yr = 50
  filingCoverage: 0.25,      // Filing years / active years
  registry: 0.15,            // In REJC registry
  localCompliance: 0.05,     // For ens locals only (skipped + redistributed when N/A)
} as const;

/** REJC dataset starts ~2014 — earlier years are not scored */
export const REJC_EARLIEST_YEAR = 2014;

/** Filing recency gap thresholds */
export const RECENCY_THRESHOLDS = {
  excellent: 2,  // gap ≤ 2 years → score 100
  good: 3,       // gap ≤ 3 years → score 50
} as const;

// ============================================================
// Score Direction Convention
// ============================================================

/**
 * All components share one direction: a higher value means a more marked
 * statistical pattern.
 *   score_volume:          more public funds received
 *   score_frequency:       more transactions per year
 *   score_dominance:       larger share within its group
 *   score_accountability:  less filed accounting
 *   menjometre_score:      higher = more concentration or recurrence
 *
 * ORDER BY score DESC lists the most marked patterns first. Check a change
 * against a reference entity whose components you have computed by hand.
 */
export const SCORE_DIRECTION = "HIGHER_IS_MORE_MARKED" as const;

// ============================================================
// Accountability Scope
// ============================================================

/**
 * Who gets score_accountability (non-NULL):
 *   - Group 1 (Filing): Obligated (DUP/fundació) + files at REJC
 *   - Group 2 (Obligated, no filing): Obligated + doesn't file → scored
 *   - Group 3 (Voluntary): Not obligated but files → scored
 *
 * Who gets NULL (excluded from accountability):
 *   - Group 4: No REJC obligation + no filing
 *   - F-prefix (cooperatives) — Registre de Cooperatives
 *   - Q-prefix (consorcis) — Sindicatura de Comptes
 *   - R-prefix (religious) — Registro Entidades Religiosas
 *   - G-prefix not in REJC registry
 *
 * Legal basis:
 *   - Art. 322-15 CCCat: DUP associations must deposit at REJC
 *   - Llei 4/2008 (Protectorat): Fundacions must deposit at REJC
 *   - Llei 19/2014 Art. 3.4: >100K/year triggers web publication (NOT REJC deposit)
 */
export const ACCOUNTABILITY_SCOPE = {
  /** Only G-prefix entities are candidates (unless obligated with other prefix) */
  defaultPrefix: "G",
  /** Obligated entities identified via REJC registry fields */
  obligatedCriteria: {
    dup: "classificacio_especifica LIKE '%UTILITAT PÚBLICA%'",
    fundacio: "tipus_entitat = 'Fundació'",
  },
} as const;
