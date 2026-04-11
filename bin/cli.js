#!/usr/bin/env node

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { validateProposal, validateDeliberation, auditTally, loadProposal } from '../src/index.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function pass(msg) { console.log(`  ${GREEN}\u2713${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}\u2717${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}\u26A0${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}\u2139${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${msg}${RESET}`); }

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
${BOLD}adp-validate${RESET} — Validate ADP proposals and audit deliberations

${BOLD}Usage:${RESET}
  adp-validate <file> [file...]           Validate one or more proposal files
  adp-validate --deliberation <dir>       Validate all proposals in a directory as a deliberation
  adp-validate --audit <dir> --weights <file>  Audit a deliberation tally

${BOLD}Examples:${RESET}
  adp-validate ./proposal.json
  adp-validate ./approve.json ./reject.json ./advisory.json
  adp-validate --deliberation ./deliberation/
  adp-validate --audit ./deliberation/ --weights weights.json

${BOLD}Options:${RESET}
  --deliberation <dir>  Validate all .json files in dir as a single deliberation
  --audit <dir>         Audit tally computation for a deliberation
  --weights <file>      JSON file mapping agent_id to weight (required for --audit)
  --tier <tier>         Override reversibility tier for audit (reversible|partially_reversible|irreversible)
  --json                Output results as JSON
  --help                Show this help

${BOLD}Weight file format:${RESET}
  { "did:adp:agent-a": 0.71, "did:adp:agent-b": 0.64 }
`);
  process.exit(0);
}

const jsonOutput = args.includes('--json');
const deliberationMode = args.includes('--deliberation');
const auditMode = args.includes('--audit');

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const tierOverride = getArgValue('--tier');
const weightsFile = getArgValue('--weights');
const inputs = args.filter(a => !a.startsWith('--') && a !== weightsFile && a !== tierOverride);

let totalErrors = 0;
let totalWarnings = 0;

async function run() {
  if (auditMode) {
    await runAudit();
  } else if (deliberationMode) {
    await runDeliberation();
  } else {
    await runValidation();
  }
}

async function runValidation() {
  heading('ADP Proposal Validator');

  if (inputs.length === 0) {
    fail('No input files provided');
    process.exit(1);
  }

  for (const input of inputs) {
    console.log(`${DIM}File: ${input}${RESET}`);

    let proposal;
    try {
      proposal = loadProposal(resolve(input));
    } catch (e) {
      fail(`Failed to load: ${e.message}`);
      totalErrors++;
      continue;
    }

    heading('Schema Validation');
    const result = validateProposal(proposal);

    if (result.errors.length === 0) {
      pass('Valid against ADP proposal schema v0');
    } else {
      for (const err of result.errors) {
        fail(err);
        totalErrors++;
      }
    }

    // Proposal info
    heading('Proposal Info');
    if (proposal.agent_id) info(`Agent: ${BOLD}${proposal.agent_id}${RESET}`);
    if (proposal.vote) info(`Vote: ${BOLD}${formatVote(proposal.vote)}${RESET}`);
    if (proposal.confidence != null) info(`Confidence: ${proposal.confidence}`);
    if (proposal.reversibility_tier) info(`Tier: ${proposal.reversibility_tier}`);

    if (proposal.action) {
      info(`Action: ${proposal.action.kind} → ${proposal.action.target}`);
    }

    if (proposal.domain_claim) {
      info(`Domain: ${proposal.domain_claim.domain}`);
    }

    // Dissent conditions
    if (Array.isArray(proposal.dissent_conditions) && proposal.dissent_conditions.length > 0) {
      heading('Dissent Conditions');
      for (const dc of proposal.dissent_conditions) {
        const statusColor = dc.status === 'active' ? CYAN
          : dc.status === 'falsified' ? GREEN
          : dc.status === 'amended' ? YELLOW
          : RED;
        info(`${dc.id} [${statusColor}${dc.status}${RESET}]: ${dc.condition}`);
        if (dc.amendments && dc.amendments.length > 0) {
          for (const am of dc.amendments) {
            info(`  ${DIM}round ${am.round}: → "${am.new_condition}" (${am.reason})${RESET}`);
          }
        }
      }
    }

    // Revisions
    if (Array.isArray(proposal.revisions) && proposal.revisions.length > 0) {
      heading('Vote Revisions');
      for (const rev of proposal.revisions) {
        info(`Round ${rev.round}: ${formatVote(rev.prior_vote)} → ${formatVote(rev.new_vote)} — ${rev.reason}`);
      }
    }

    // Blast radius
    if (proposal.blast_radius) {
      heading('Blast Radius');
      const br = proposal.blast_radius;
      if (br.scope) info(`Scope: ${br.scope.join(', ')}`);
      info(`Users affected: ${br.estimated_users_affected}`);
      info(`Rollback cost: ${br.rollback_cost_seconds}s`);
    }

    // Warnings
    if (result.warnings.length > 0) {
      heading('Warnings');
      for (const w of result.warnings) {
        warn(w);
        totalWarnings++;
      }
    }

    if (inputs.length > 1) console.log(`\n${'─'.repeat(60)}`);
  }

  printResult();
}

async function runDeliberation() {
  heading('ADP Deliberation Validator');

  const dir = inputs[0];
  if (!dir || !existsSync(dir)) {
    fail(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(dir, f));

  if (files.length === 0) {
    fail('No .json files found in directory');
    process.exit(1);
  }

  console.log(`${DIM}Directory: ${dir} (${files.length} proposals)${RESET}`);

  const proposals = [];
  for (const file of files) {
    try {
      const obj = loadProposal(resolve(file));
      if (obj.proposal_id) {
        proposals.push(obj);
      }
    } catch (e) {
      fail(`Failed to load ${file}: ${e.message}`);
      totalErrors++;
    }
  }

  if (proposals.length === 0) {
    fail('No valid proposals loaded');
    process.exit(1);
  }

  const result = validateDeliberation(proposals);

  // Individual results
  heading('Individual Proposals');
  for (const pr of result.proposals) {
    const icon = pr.valid ? `${GREEN}\u2713${RESET}` : `${RED}\u2717${RESET}`;
    const warnCount = pr.warnings.length > 0 ? ` ${YELLOW}(${pr.warnings.length} warning${pr.warnings.length > 1 ? 's' : ''})${RESET}` : '';
    console.log(`  ${icon} ${pr.agent_id}${warnCount}`);
  }

  // Cross-proposal checks
  heading('Deliberation Consistency');
  if (result.errors.length === 0) {
    pass('All cross-proposal checks passed');
  }
  for (const err of result.errors) {
    fail(err);
    totalErrors++;
  }

  // Summary
  heading('Deliberation Summary');
  const dlbId = proposals[0]?.deliberation_id;
  if (dlbId) info(`Deliberation: ${dlbId}`);

  const action = proposals[0]?.action;
  if (action) info(`Action: ${action.kind} → ${action.target}`);

  const votes = { approve: 0, reject: 0, abstain: 0 };
  for (const p of proposals) {
    const v = getCurrentVote(p);
    if (votes[v] != null) votes[v]++;
  }
  info(`Votes: ${GREEN}${votes.approve} approve${RESET}, ${RED}${votes.reject} reject${RESET}, ${DIM}${votes.abstain} abstain${RESET}`);

  if (result.warnings.length > 0) {
    heading('Warnings');
    for (const w of result.warnings) {
      warn(w);
      totalWarnings++;
    }
  }

  printResult();
}

async function runAudit() {
  heading('ADP Deliberation Audit');

  const dir = inputs[0];
  if (!dir || !existsSync(dir)) {
    fail(`Directory not found: ${dir}`);
    process.exit(1);
  }

  if (!weightsFile) {
    fail('--audit requires --weights <file>');
    process.exit(1);
  }

  let weights;
  try {
    weights = JSON.parse(readFileSync(resolve(weightsFile), 'utf-8'));
  } catch (e) {
    fail(`Failed to load weights file: ${e.message}`);
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(dir, f));

  const proposals = [];
  for (const file of files) {
    try {
      const obj = loadProposal(resolve(file));
      if (obj.proposal_id) {
        proposals.push(obj);
      }
    } catch (e) {
      fail(`Failed to load ${file}: ${e.message}`);
      totalErrors++;
    }
  }

  // Determine tier
  const tiers = new Set(proposals.map(p => p.reversibility_tier).filter(Boolean));
  const tier = tierOverride || getHighestTier(tiers);
  console.log(`${DIM}Tier: ${tier} | ${proposals.length} proposals${RESET}`);

  // Run tally audit
  heading('Tally Computation');
  const audit = auditTally(proposals, weights, tier);

  for (const line of audit.details) {
    if (line === '') {
      console.log('');
    } else if (line.includes('✓')) {
      pass(line);
    } else if (line.includes('✗')) {
      fail(line);
    } else {
      info(line);
    }
  }

  heading('Result');
  if (audit.converged) {
    pass(`${BOLD}CONVERGED${RESET}`);
  } else {
    const reasons = [];
    if (!audit.thresholdMet) reasons.push('threshold not met');
    if (!audit.participationFloorMet) reasons.push('participation floor not met');
    fail(`${BOLD}NOT CONVERGED${RESET} — ${reasons.join(', ')}`);
  }

  printResult();
}

function getCurrentVote(proposal) {
  if (Array.isArray(proposal.revisions) && proposal.revisions.length > 0) {
    return proposal.revisions[proposal.revisions.length - 1].new_vote;
  }
  return proposal.vote;
}

function formatVote(vote) {
  switch (vote) {
    case 'approve': return `${GREEN}approve${RESET}`;
    case 'reject': return `${RED}reject${RESET}`;
    case 'abstain': return `${DIM}abstain${RESET}`;
    default: return vote;
  }
}

function getHighestTier(tiers) {
  if (tiers.has('irreversible')) return 'irreversible';
  if (tiers.has('partially_reversible')) return 'partially_reversible';
  return 'reversible';
}

function printResult() {
  console.log('');
  if (totalErrors === 0 && totalWarnings === 0) {
    console.log(`${GREEN}${BOLD}\u2713 All checks passed${RESET}`);
    process.exit(0);
  } else if (totalErrors === 0) {
    console.log(`${GREEN}${BOLD}\u2713 All checks passed${RESET} ${YELLOW}(${totalWarnings} warning${totalWarnings > 1 ? 's' : ''})${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}\u2717 ${totalErrors} error(s) found${RESET}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(2);
});
