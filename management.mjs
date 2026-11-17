import assert from 'node:assert/strict';
import { load, verifyPlan, verifyDeployment, verifyProposal, rpc, GENESIS, PROGRAM, OWNERS, txPda, bytes, msDecode, roster, equal, finalRoster, phaseOwners } from './sandbox.mjs';

export async function management(owner = null, readRpc = rpc) {
  assert(owner === null || OWNERS.includes(owner), 'Only your two test wallets are supported');
  const plan = await load('outputs/plan.json'); verifyPlan(plan);
  const proof = await load('outputs/rehearsal.json');
  assert.equal(proof.status, 'PASSED'); assert.equal(proof.planSha256, plan.planSha256);
  assert.equal(await readRpc('getGenesisHash'), GENESIS);
  const reference = await load('inputs/public-mainnet-reference.json');
  const result = await readRpc('getMultipleAccounts', [[plan.multisig, String(PROGRAM), reference.programDataAddress, String(txPda(plan, 1)), String(txPda(plan, 2)), plan.vault], { encoding: 'base64', commitment: 'confirmed' }]);
  const [ms, program, data, add, remove, vault] = result.value;
  verifyDeployment(plan, reference, program, data);
  assert(ms && ms.owner === String(PROGRAM), 'Existing test multisig not found. No creation action is available here.');
  const state = msDecode(bytes(ms)); assert.equal(state.threshold, 2);
  const owners = roster(state), expanded = [...OWNERS, ...plan.addedOwners.map(row => row.address)];
  assert([OWNERS, expanded, finalRoster(plan)].some(keys => equal(owners, keys)), 'Unexpected owner set');
  const added = await verifyProposal(plan, 'add', add, readRpc), removed = await verifyProposal(plan, 'remove', remove, readRpc);
  assert(!removed || (added && 'executed' in added.status), 'Removal before addition execution');
  assert.equal(state.transactionIndex, removed ? 2 : added ? 1 : 0, 'Unreviewed proposal index. Stop.');
  const complete = Boolean(removed && 'executed' in removed.status);
  assert(equal(owners, complete ? finalRoster(plan) : added && 'executed' in added.status ? expanded : OWNERS), 'Roster does not match proposal progress');
  const current = complete ? null : added && 'executed' in added.status ? 'remove' : 'add';
  const names = new Map([...plan.addedOwners, { address: OWNERS[0], name: 'Your browser wallet' }, { address: OWNERS[1], name: 'Your committee Ledger' }].map(row => [row.address, row.name]));
  const proposals = ['add', 'remove'].map((phase, i) => {
    const stored = i ? removed : added, status = stored ? Object.keys(stored.status)[0] : 'not proposed', approvals = stored?.approved.map(String) || [];
    let availableAction = null;
    if (owner && phase === current && owners.includes(owner)) {
      if ((!stored || status === 'draft') && owner === OWNERS[0]) availableAction = 'upload';
      else if (status === 'active' && !approvals.includes(owner)) availableAction = 'approve';
      else if (status === 'executeReady' && approvals.length >= 2) availableAction = 'execute';
    }
    return { index: i + 1, address: String(txPda(plan, i + 1)), phase, title: i ? 'Remove Fixture 2 + Fixture 3' : 'Add eight committee owners', status, approvals, threshold: 2, yourVote: owner ? approvals.includes(owner) ? 'Approved' : owners.includes(owner) ? 'Not voted' : 'Not an owner' : 'Not connected', attachedInstructions: stored?.instructionIndex || 0, instructionCount: phaseOwners(plan, phase).length, actions: phaseOwners(plan, phase).map(row => ({ kind: phase === 'add' ? 'addMember' : 'removeMember', name: row.name, address: row.address })), availableAction };
  });
  return { planSha256: plan.planSha256, multisig: plan.multisig, vault: plan.vault, program: String(PROGRAM), slot: result.context.slot, threshold: state.threshold, owners: owners.map(address => ({ address, name: names.get(address) || 'Unknown', connected: address === owner })), vaultSol: (vault?.lamports || 0) / 1e9, connected: owner, complete, currentPhase: current, proposals, scope: 'Existing isolated Squads v3 test. No creation, subscriptions, asset transfers or arbitrary proposals.' };
}
