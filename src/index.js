import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, '..', 'schema', 'v0.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

/**
 * Validate a single proposal object against the schema and semantic rules.
 * @param {object} proposal - Parsed proposal JSON
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateProposal(proposal) {
  const errors = [];
  const warnings = [];

  // --- Schema validation ---
  const schemaValid = validateSchema(proposal);
  if (!schemaValid && validateSchema.errors) {
    for (const err of validateSchema.errors) {
      const path = err.instancePath || '(root)';
      errors.push(`${path}: ${err.message}`);
    }
  }

  // If schema failed badly, skip semantic checks
  if (!proposal || typeof proposal !== 'object') {
    return { valid: errors.length === 0, errors, warnings };
  }

  // --- Semantic: dissent condition consistency ---
  if (Array.isArray(proposal.dissent_conditions)) {
    const dcIds = new Set();

    for (let i = 0; i < proposal.dissent_conditions.length; i++) {
      const dc = proposal.dissent_conditions[i];
      const path = `dissent_conditions[${i}]`;

      // Duplicate IDs
      if (dc.id) {
        if (dcIds.has(dc.id)) {
          errors.push(`${path}: duplicate dissent condition id "${dc.id}"`);
        }
        dcIds.add(dc.id);
      }

      if (dc.status === 'falsified') {
        if (dc.tested_in_round == null) {
          errors.push(`${path}: status is "falsified" but tested_in_round is null`);
        }
        if (dc.tested_by == null) {
          errors.push(`${path}: status is "falsified" but tested_by is null`);
        }
      }

      if (dc.status === 'amended') {
        if (!Array.isArray(dc.amendments) || dc.amendments.length === 0) {
          errors.push(`${path}: status is "amended" but amendments array is empty`);
        }
        if (dc.tested_in_round == null) {
          errors.push(`${path}: status is "amended" but tested_in_round is null`);
        }
        if (dc.tested_by == null) {
          errors.push(`${path}: status is "amended" but tested_by is null`);
        }
      }

      // Amendment round ordering
      if (Array.isArray(dc.amendments) && dc.amendments.length > 1) {
        for (let j = 1; j < dc.amendments.length; j++) {
          if (dc.amendments[j].round < dc.amendments[j - 1].round) {
            errors.push(`${path}.amendments[${j}]: round ${dc.amendments[j].round} is earlier than previous amendment round ${dc.amendments[j - 1].round}`);
          }
        }
      }
    }
  }

  // --- Semantic: revision chain consistency ---
  if (Array.isArray(proposal.revisions) && proposal.revisions.length > 0) {
    const revisions = proposal.revisions;

    // First revision's prior_vote must match original vote
    if (proposal.vote && revisions[0].prior_vote !== proposal.vote) {
      errors.push(`revisions[0]: prior_vote "${revisions[0].prior_vote}" does not match original vote "${proposal.vote}"`);
    }

    // First revision's prior_confidence must match original confidence
    if (proposal.confidence != null && revisions[0].prior_confidence != null) {
      if (revisions[0].prior_confidence !== proposal.confidence) {
        errors.push(`revisions[0]: prior_confidence ${revisions[0].prior_confidence} does not match original confidence ${proposal.confidence}`);
      }
    }

    // Chain consistency: each revision's prior must match previous revision's new
    for (let i = 1; i < revisions.length; i++) {
      if (revisions[i].prior_vote !== revisions[i - 1].new_vote) {
        errors.push(`revisions[${i}]: prior_vote "${revisions[i].prior_vote}" does not match previous revision's new_vote "${revisions[i - 1].new_vote}"`);
      }

      // Round ordering
      if (revisions[i].round <= revisions[i - 1].round) {
        errors.push(`revisions[${i}]: round ${revisions[i].round} is not greater than previous round ${revisions[i - 1].round}`);
      }
    }

    // No-op revision (vote didn't change)
    for (let i = 0; i < revisions.length; i++) {
      if (revisions[i].prior_vote === revisions[i].new_vote &&
          revisions[i].prior_confidence === revisions[i].new_confidence) {
        warnings.push(`revisions[${i}]: vote and confidence unchanged — this is a no-op revision`);
      }
    }
  }

  // --- Semantic: blast radius vs reversibility tier ---
  if (proposal.blast_radius && proposal.reversibility_tier) {
    const br = proposal.blast_radius;

    if (proposal.reversibility_tier === 'irreversible') {
      if (br.rollback_cost_seconds != null && br.rollback_cost_seconds < 30) {
        warnings.push(`blast_radius.rollback_cost_seconds is ${br.rollback_cost_seconds}s but tier is "irreversible" — is the tier over-declared?`);
      }
      if (br.estimated_users_affected === 0) {
        warnings.push(`blast_radius.estimated_users_affected is 0 but tier is "irreversible" — is the tier over-declared?`);
      }
    }

    if (proposal.reversibility_tier === 'reversible') {
      if (br.rollback_cost_seconds != null && br.rollback_cost_seconds > 3600) {
        warnings.push(`blast_radius.rollback_cost_seconds is ${br.rollback_cost_seconds}s but tier is "reversible" — is the tier under-declared?`);
      }
      if (br.estimated_users_affected > 100000) {
        warnings.push(`blast_radius.estimated_users_affected is ${br.estimated_users_affected} but tier is "reversible" — is the tier under-declared?`);
      }
    }
  }

  // --- Semantic: confidence of 1.0 or 0.0 ---
  if (proposal.confidence === 1.0) {
    warnings.push(`confidence is 1.0 — perfect certainty is unlikely and will be penalized by calibration scoring if wrong`);
  }
  if (proposal.confidence === 0.0 && proposal.vote !== 'abstain') {
    warnings.push(`confidence is 0.0 but vote is "${proposal.vote}" — zero confidence typically warrants abstention`);
  }

  // --- Semantic: empty dissent conditions on reject ---
  if (proposal.vote === 'reject' &&
      Array.isArray(proposal.dissent_conditions) &&
      proposal.dissent_conditions.length === 0) {
    warnings.push(`vote is "reject" but no dissent_conditions declared — other agents have nothing to falsify`);
  }

  // --- Semantic: calibration_at_stake false with high stake ---
  if (proposal.stake) {
    if (proposal.stake.magnitude === 'high' && !proposal.stake.calibration_at_stake) {
      warnings.push(`stake magnitude is "high" but calibration_at_stake is false — high stake without accountability`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a set of proposals as a deliberation.
 * Checks cross-proposal consistency beyond individual validity.
 * @param {object[]} proposals - Array of parsed proposal objects
 * @returns {{ valid: boolean, errors: string[], warnings: string[], proposals: object[] }}
 */
export function validateDeliberation(proposals) {
  const errors = [];
  const warnings = [];
  const proposalResults = [];

  // Validate each proposal individually
  for (let i = 0; i < proposals.length; i++) {
    const result = validateProposal(proposals[i]);
    proposalResults.push({
      agent_id: proposals[i].agent_id || `(unknown agent #${i})`,
      ...result,
    });
    for (const err of result.errors) {
      errors.push(`[${proposals[i].agent_id || `#${i}`}] ${err}`);
    }
    for (const w of result.warnings) {
      warnings.push(`[${proposals[i].agent_id || `#${i}`}] ${w}`);
    }
  }

  if (proposals.length < 2) {
    warnings.push(`deliberation has ${proposals.length} proposal(s) — meaningful deliberation requires at least 2`);
  }

  // --- Cross-proposal: shared deliberation_id ---
  const dlbIds = new Set(proposals.map(p => p.deliberation_id).filter(Boolean));
  if (dlbIds.size > 1) {
    errors.push(`proposals reference ${dlbIds.size} different deliberation_ids: ${[...dlbIds].join(', ')}`);
  }

  // --- Cross-proposal: shared action ---
  const actions = proposals.map(p => JSON.stringify(p.action)).filter(Boolean);
  const uniqueActions = new Set(actions);
  if (uniqueActions.size > 1) {
    errors.push(`proposals reference ${uniqueActions.size} different actions — all proposals in a deliberation must share the same action`);
  }

  // --- Cross-proposal: unique agent_ids ---
  const agentIds = proposals.map(p => p.agent_id).filter(Boolean);
  const agentDupes = agentIds.filter((id, i) => agentIds.indexOf(id) !== i);
  if (agentDupes.length > 0) {
    errors.push(`duplicate agent_ids in deliberation: ${[...new Set(agentDupes)].join(', ')}`);
  }

  // --- Cross-proposal: reversibility tier agreement ---
  const tiers = new Set(proposals.map(p => p.reversibility_tier).filter(Boolean));
  if (tiers.size > 1) {
    warnings.push(`proposals declare different reversibility tiers: ${[...tiers].join(', ')} — highest tier governs convergence threshold`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    proposals: proposalResults,
  };
}

/**
 * Compute a weighted tally from proposals and verify convergence.
 * @param {object[]} proposals - Array of proposal objects (with current votes from revisions)
 * @param {Object<string, number>} weights - Map of agent_id to computed weight
 * @param {string} tier - Reversibility tier for threshold lookup
 * @param {object} [config] - Optional config overrides
 * @param {number} [config.participationFloor=0.50] - Participation floor
 * @returns {{ tally: object, converged: boolean, details: string[] }}
 */
export function auditTally(proposals, weights, tier, config = {}) {
  const participationFloor = config.participationFloor ?? 0.50;
  const details = [];

  let approveWeight = 0;
  let rejectWeight = 0;
  let abstainWeight = 0;

  for (const p of proposals) {
    const weight = weights[p.agent_id] ?? 0;
    const currentVote = getCurrentVote(p);

    switch (currentVote) {
      case 'approve': approveWeight += weight; break;
      case 'reject': rejectWeight += weight; break;
      case 'abstain': abstainWeight += weight; break;
    }

    details.push(`${p.agent_id}: vote=${currentVote}, weight=${weight.toFixed(3)}`);
  }

  const totalWeight = approveWeight + rejectWeight + abstainWeight;
  const nonAbstainingWeight = approveWeight + rejectWeight;

  const approvalFraction = nonAbstainingWeight > 0
    ? approveWeight / nonAbstainingWeight
    : 0;

  const participationFraction = totalWeight > 0
    ? nonAbstainingWeight / totalWeight
    : 0;

  const threshold = getThreshold(tier);
  const thresholdMet = approvalFraction >= threshold;
  const participationFloorMet = participationFraction >= participationFloor;
  const converged = thresholdMet && participationFloorMet;

  details.push('');
  details.push(`approve:       ${approveWeight.toFixed(3)}`);
  details.push(`reject:        ${rejectWeight.toFixed(3)}`);
  details.push(`abstain:       ${abstainWeight.toFixed(3)}`);
  details.push(`total:         ${totalWeight.toFixed(3)}`);
  details.push('');
  details.push(`approval:      ${(approvalFraction * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%) ${thresholdMet ? '✓' : '✗'}`);
  details.push(`participation: ${(participationFraction * 100).toFixed(1)}% (floor: ${(participationFloor * 100).toFixed(1)}%) ${participationFloorMet ? '✓' : '✗'}`);

  return {
    tally: {
      approveWeight,
      rejectWeight,
      abstainWeight,
      totalWeight,
      approvalFraction,
      participationFraction,
    },
    converged,
    thresholdMet,
    participationFloorMet,
    details,
  };
}

/**
 * Get the current vote from a proposal, accounting for revisions.
 */
function getCurrentVote(proposal) {
  if (Array.isArray(proposal.revisions) && proposal.revisions.length > 0) {
    return proposal.revisions[proposal.revisions.length - 1].new_vote;
  }
  return proposal.vote;
}

/**
 * Threshold lookup (spec Section 5.1).
 */
function getThreshold(tier) {
  switch (tier) {
    case 'reversible': return 0.501; // strictly > 50%
    case 'partially_reversible': return 0.60;
    case 'irreversible': return 2 / 3;
    default: return 0.501;
  }
}

/**
 * Load a proposal from a file path.
 * @param {string} filePath
 * @returns {object}
 */
export function loadProposal(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
