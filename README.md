# adp-validate

Validate [ADP](https://adp-manifest.dev) proposal objects and audit deliberation traces.

## Install

```bash
npm install -g adp-validate
```

## Usage

### Validate a proposal

```bash
adp-validate ./proposal.json
```

```
ADP Proposal Validator
File: ./proposal.json

Schema Validation
  ✓ Valid against ADP proposal schema v0

Proposal Info
  ℹ Agent: did:adp:test-runner-v2
  ℹ Vote: approve
  ℹ Confidence: 0.86
  ℹ Tier: partially_reversible
  ℹ Action: merge_pull_request → github.com/acme/api#4471
  ℹ Domain: code.correctness

Dissent Conditions
  ℹ dc_tr_01 [active]: if any test marked critical regresses
  ℹ dc_tr_02 [active]: if coverage delta is negative

✓ All checks passed
```

### Validate multiple proposals

```bash
adp-validate ./approve.json ./reject.json ./advisory.json
```

### Validate a deliberation

Pass a directory of proposal files to check cross-proposal consistency:

```bash
adp-validate --deliberation ./deliberation/
```

Checks:
- Each proposal is individually valid (schema + semantic)
- All proposals share the same `deliberation_id` and `action`
- No duplicate `agent_id`s
- Reversibility tier agreement across proposals

### Audit a deliberation tally

Verify that weighted voting and convergence were computed correctly:

```bash
adp-validate --audit ./deliberation/ --weights weights.json
```

The weights file maps agent IDs to computed weights:

```json
{
  "did:adp:test-runner-v2": 0.71,
  "did:adp:security-scanner-v3": 0.64,
  "did:adp:style-linter-v1": 0.18
}
```

Output includes the full tally computation and convergence determination:

```
Tally Computation
  ℹ did:adp:test-runner-v2: vote=approve, weight=0.710
  ℹ did:adp:security-scanner-v3: vote=reject, weight=0.640
  ℹ did:adp:style-linter-v1: vote=approve, weight=0.180

  ℹ approve:       0.890
  ℹ reject:        0.640
  ℹ total:         1.530

  ✗ approval:      58.2% (threshold: 60.0%) ✗
  ✓ participation: 100.0% (floor: 50.0%) ✓

Result
  ✗ NOT CONVERGED — threshold not met
```

## Semantic Checks

Beyond JSON Schema validation, adp-validate checks:

| Check | Type |
|-------|------|
| Dissent condition status consistency (`falsified` requires `tested_in_round` and `tested_by`) | Error |
| Dissent condition amendment consistency (`amended` requires non-empty `amendments`) | Error |
| Duplicate dissent condition IDs | Error |
| Vote revision chain integrity (each `prior_vote` must match previous `new_vote`) | Error |
| Revision round ordering (must be strictly increasing) | Error |
| Blast radius vs. reversibility tier mismatch (low rollback cost + `irreversible`) | Warning |
| Confidence of exactly 1.0 or 0.0 | Warning |
| Reject vote with no dissent conditions | Warning |
| High stake without calibration accountability | Warning |

## Options

```
--deliberation <dir>  Validate all .json files in dir as a deliberation
--audit <dir>         Audit tally computation for a deliberation
--weights <file>      JSON file mapping agent_id to weight (for --audit)
--tier <tier>         Override reversibility tier for audit
--json                Output results as JSON
--help                Show help
```

## Programmatic Use

```javascript
import { validateProposal, validateDeliberation, auditTally } from 'adp-validate';

const result = validateProposal(proposal);
// { valid: boolean, errors: string[], warnings: string[] }

const dlbResult = validateDeliberation([proposal1, proposal2]);
// { valid: boolean, errors: string[], warnings: string[], proposals: object[] }

const audit = auditTally(proposals, weights, 'partially_reversible');
// { tally: object, converged: boolean, thresholdMet: boolean, participationFloorMet: boolean }
```

## Status

**v0.1** — Validates against ADP spec v0.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) for the full license text and [`NOTICE`](NOTICE) for attribution.
