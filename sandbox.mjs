import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(new URL('./package.json', import.meta.url));
export const { PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
const { default: Squads, getMsPDA, getTxPDA, getIxPDA } = require('@sqds/sdk');
const BN = require('bn.js');
export const { LiteSVM, FailedTransactionMetadata, Rent } = require('litesvm');
const { Connection } = require('@solana/web3.js');
export const ROOT = new URL('./', import.meta.url);
export const OLD = new URL('./reference/', import.meta.url);
export const PROGRAM = new PublicKey('SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu');
export const RPC = 'https://api.mainnet.solana.com';
export const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const COMMITTEE_OWNER = 'G7Eawo4c77kVYJqSAB6rMzv7d2Jy3hQu5X5BitRgcaeP';
export const OWNERS = ['CqgQWBP92uTRahafsg4urinSgLbMDZEDk31RnzM5LL9M', COMMITTEE_OWNER];
export const ADDED_OWNERS = Object.freeze([
  'ELxYQDV37xjhFXkNTwSiBHpvWSQjubrqkNYKcNHj4hRX',
  '4QtFHzZA38nTUQJEPB8X3wbS2EcSerZriyEtyaNu2SfG',
  '9tN2oyakuzvdG57mVrzhG1XmDx3WUpwebsMDAcdVx85q',
  '2bMP5zUUjvMnLs5JN637GXtTaRfCYM8DNisPu49h2Kos',
  '7Zqtt6yTcdkrJeQwhH5Zog1RnBnFVKBGgzFFHdN5U8UW',
  'AMyYVuMQNrKhZt453M8mYvU7iHaL2BQb9AVA4fhCFjy3',
  '4Q6d3kju7an5EnXWFzqH5bqjabYHFuB8MGq9gYAPG6AS',
  'BmMMWzAKyFpsTrkeFXjATpBkVf5ZkgwNqKpg8YQokfTW',
]);
export const REMOVED_OWNERS = Object.freeze([ADDED_OWNERS[1], ADDED_OWNERS[2]]);
export const finalRoster = plan => [...plan.owners, ...plan.addedOwners.map(row => row.address)].filter(address => !plan.removedOwners.some(row => row.address === address));
export const phaseOwners = (plan, phase) => {
  assert(['add', 'remove'].includes(phase), 'Unknown phase');
  return phase === 'add' ? plan.addedOwners : plan.removedOwners;
};
const FORBIDDEN = ['CEbm1TXTFEQLB4T8Senfi6mDPfLqiF4hZvZP9Ehg82Qg', 'GrAj8xNx6rHwRT38eCATRZWnozWZQwRaQQuasF1f7BL8', 'CVW8dbAp1oT7xvbGvxQYpXxNa7MYdnqYqLPFA6ZkhRrX'];
export const sha = value => createHash('sha256').update(value).digest('hex');
export const load = async file => JSON.parse(await readFile(new URL(file, ROOT), 'utf8'));
export async function save(file, data) { await mkdir(new URL('./', new URL(file, ROOT)), { recursive: true }); await writeFile(new URL(file, ROOT), JSON.stringify(data, null, 2) + '\n'); }
export const key = address => new PublicKey(address);
export function sdk(owner = OWNERS[0]) {
  return new Squads({ connection: new Connection('http://127.0.0.1:8899'), multisigProgramId: PROGRAM, wallet: { publicKey: key(owner), signTransaction() { throw Error('No backend signing'); }, signAllTransactions() { throw Error('No backend signing'); } } });
}
export const coder = sdk().multisig.coder;
export const encode = ix => ({ programId: String(ix.programId), keys: ix.keys.map(k => ({ pubkey: String(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), dataBase64: Buffer.from(ix.data).toString('base64') });
export const txPda = (p, index) => getTxPDA(key(p.multisig), new BN(index), PROGRAM)[0];
export const ixPda = (tx, index) => getIxPDA(tx, new BN(index), PROGRAM)[0];
export const bytes = info => Buffer.from(info.data[0], 'base64');
export const msDecode = data => coder.accounts.decode('Ms', Buffer.from(data));
export const txDecode = data => coder.accounts.decode('MsTransaction', Buffer.from(data));
export const roster = state => state.keys.map(String).sort();
export const equal = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');
const READS = new Set(['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getMinimumBalanceForRentExemption', 'getLatestBlockhash', 'getFeeForMessage', 'simulateTransaction', 'getTransaction', 'getSignatureStatuses']);
export async function rpc(method, params = []) {
  assert(READS.has(method), 'Backend is read-only; broadcasts forbidden');
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(45000) });
  const body = await r.json();
  assert(r.ok && !body.error, `Preparation RPC ${method} at ${new URL(RPC).hostname}, HTTP ${r.status}: ${JSON.stringify(body.error || r.status)}`);
  return body.result;
}
export async function actions(plan, phase) {
  verifyPlan(plan);
  const methods = sdk().multisig.methods;
  const result = [];
  for (const row of phaseOwners(plan, phase)) result.push(await (phase === 'add' ? methods.addMember(key(row.address)) : methods.removeMember(key(row.address))).accounts({ multisig: key(plan.multisig) }).instruction());
  return result;
}
export function packet(instructions, owner, blockhash) {
  return new Transaction({ feePayer: key(owner), recentBlockhash: blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ...instructions);
}
export function pack(instructions, owner) {
  const batches = []; let current = [];
  const size = items => packet(items, owner, '11111111111111111111111111111111').serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  for (const ix of instructions) {
    let fits = false;
    try { fits = size([...current, ix]) <= 1150; } catch { /* Split oversized candidate. */ }
    if (!fits && current.length) { batches.push(current); current = []; }
    current.push(ix); assert(size(current) <= 1150);
  }
  if (current.length) batches.push(current);
  return batches;
}
export async function executeIx(plan, phase, owner) {
  const tx = txPda(plan, phase === 'add' ? 1 : 2);
  const expanded = (await actions(plan, phase)).flatMap((ix, i) => [{ pubkey: ixPda(tx, i + 1), isSigner: false, isWritable: false }, { pubkey: ix.programId, isSigner: false, isWritable: false }, ...ix.keys.map(k => ({ ...k, isSigner: false }))]);
  const unique = [];
  const indices = expanded.map(k => { let i = unique.findIndex(x => x.pubkey.equals(k.pubkey) && x.isWritable === k.isWritable); if (i < 0) { i = unique.length; unique.push(k); } return i; });
  const ix = await sdk(owner).multisig.methods.executeTransaction(Buffer.from(indices)).accounts({ multisig: key(plan.multisig), transaction: tx, member: key(owner) }).instruction();
  ix.keys.push(...unique); return ix;
}
export async function staging(plan, phase, { attached = 0, created = false, topUp = 0 } = {}) {
  const owner = OWNERS[0], ms = key(plan.multisig), index = phase === 'add' ? 1 : 2, tx = txPda(plan, index), client = sdk(owner);
  const inner = await actions(plan, phase), outer = [];
  assert(Number.isInteger(attached) && attached >= 0 && attached <= inner.length, 'Unexpected attached instruction count');
  assert(created || attached === 0, 'Cannot resume instructions without a proposal');
  if (topUp) outer.push(SystemProgram.transfer({ fromPubkey: key(owner), toPubkey: ms, lamports: topUp }));
  if (!created) outer.push(await client.buildCreateTransaction(ms, 0, index));
  for (let i = attached; i < inner.length; i++) outer.push(await client.buildAddInstruction(ms, tx, inner[i], i + 1));
  outer.push(await client.buildActivateTransaction(ms, tx), await client.buildApproveTransaction(ms, tx));
  return pack(outer, owner);
}
export function verifyPlan(p) {
  const { planSha256, ...body } = p;
  assert.equal(sha(JSON.stringify(body)), planSha256, 'Plan changed');
  assert.equal(p.chain, GENESIS); assert.equal(p.program, String(PROGRAM)); assert.equal(p.threshold, 2); assert.deepEqual(p.owners, OWNERS);
  assert.deepEqual(p.addedOwners.map(row => row.address), ADDED_OWNERS, 'Exact eight additions must be preserved');
  assert.deepEqual(p.removedOwners?.map(row => row.address), REMOVED_OWNERS, 'Remove only Fixture 2 and Fixture 3');
  assert.deepEqual(p.removedOwners.map(row => row.name), ['Fixture 2', 'Fixture 3'], 'Removal identities must match');
  assert.deepEqual(p.stages, ['2 of 2', '2 of 10', '2 of 8']);
  assert.equal(finalRoster(p).length, 8);
  assert.deepEqual(p.finalOwners, finalRoster(p), 'Exact final eight-owner roster must match');
  assert(OWNERS.every(address => p.finalOwners.includes(address)), 'Initial owners must remain');
  assert.equal(new Set([...p.owners, ...p.addedOwners.map(x => x.address)]).size, 10);
  for (const address of [...p.owners, ...p.addedOwners.map(x => x.address)]) assert(PublicKey.isOnCurve(key(address).toBytes()), 'Owner must be on curve');
  assert.equal(String(getMsPDA(key(p.createKey), PROGRAM)[0]), p.multisig);
  assert.equal(String(sdk().getAuthorityPDA(key(p.multisig), 1)), p.vault);
  assert(!FORBIDDEN.includes(p.multisig) && !FORBIDDEN.includes(p.vault));
}
export async function prepare() {
  try { await readFile(new URL('outputs/plan.json', ROOT)); throw Error('Plan exists. Do not overwrite an existing test address.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const committee = JSON.parse(await readFile(new URL('inputs/desired-owners.json', OLD), 'utf8'));
  assert.equal(committee.length, 9);
  const createKey = key(randomBytes(32)), multisig = getMsPDA(createKey, PROGRAM)[0], vault = sdk().getAuthorityPDA(multisig, 1);
  const elf = await readFile(new URL('sources/squads-mainnet.so', OLD));
  const p = { label: 'TEST ONLY - Demo owner add-remove rehearsal', chain: GENESIS, program: String(PROGRAM), createKey: String(createKey), multisig: String(multisig), vault: String(vault), owners: OWNERS, threshold: 2, addedOwners: committee.filter(x => x.address !== COMMITTEE_OWNER), removedOwners: REMOVED_OWNERS.map(address => committee.find(row => row.address === address)), programElfSha256: sha(elf), createdAt: new Date().toISOString(), stages: ['2 of 2', '2 of 10', '2 of 8'], preparedOnly: true };
  p.finalOwners = finalRoster(p);
  p.planSha256 = sha(JSON.stringify(p)); verifyPlan(p);
  assert.equal(await rpc('getGenesisHash'), GENESIS);
  const deployment = await rpc('getAccountInfo', [String(PROGRAM), { encoding: 'base64', commitment: 'finalized' }]);
  const dataAddress = String(key(bytes(deployment.value).subarray(4, 36)));
  const programData = await rpc('getAccountInfo', [dataAddress, { encoding: 'base64', commitment: 'finalized' }]);
  assert.equal(sha(bytes(programData.value).subarray(45)), p.programElfSha256, 'Deployed program changed');
  const rent = await rpc('getAccountInfo', ['SysvarRent111111111111111111111111111111111', { encoding: 'base64', commitment: 'finalized' }]);
  await save('inputs/public-mainnet-reference.json', { programDataAddress: dataAddress, deploymentSlot: String(bytes(programData.value).readBigUInt64LE(4)), programElfSha256: p.programElfSha256, rpcSlot: programData.context.slot, rent: rent.value });
  await save('outputs/plan.json', p);
  const create = await sdk().buildCreateMultisig(2, createKey, OWNERS.map(key), p.label, 'No DAO assets or authorities. Both initial owners controlled by Demo.');
  await save('outputs/instructions.json', { planSha256: p.planSha256, create: encode(create), add: (await actions(p, 'add')).map(encode), remove: (await actions(p, 'remove')).map(encode), note: 'Inner settings instructions require Squads authority 0 execution; not direct wallet calls.' });
  console.log(JSON.stringify(p, null, 2));
}
export function verifyDeployment(plan, reference, program, pd) {
  const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
  assert(program?.executable && program.owner === loader, 'Unexpected program account');
  assert.equal(bytes(program).readUInt32LE(0), 2, 'Unexpected program loader state');
  assert.equal(String(key(bytes(program).subarray(4, 36))), reference.programDataAddress);
  assert(pd && !pd.executable && pd.owner === loader, 'Unexpected program data account');
  assert.equal(bytes(pd).readUInt32LE(0), 3, 'Unexpected program data loader state');
  assert.equal(reference.programElfSha256, plan.programElfSha256);
  assert.equal(sha(bytes(pd).subarray(45)), plan.programElfSha256, 'Deployed program changed: stop');
}
export async function verifyProposal(plan, phase, info, readRpc) {
  if (!info) return null;
  assert.equal(info.owner, String(PROGRAM));
  const stored = txDecode(bytes(info)), index = phase === 'add' ? 1 : 2;
  const count = phaseOwners(plan, phase).length;
  assert(stored.ms.equals(key(plan.multisig)) && stored.creator.equals(key(OWNERS[0])), 'Unexpected proposal identity');
  assert.equal(stored.transactionIndex, index, 'Unexpected proposal index');
  assert.equal(stored.authorityIndex, 0, 'Unexpected proposal authority');
  assert(Number.isInteger(stored.instructionIndex) && stored.instructionIndex >= 0 && stored.instructionIndex <= count, 'Unexpected phase instruction count');
  assert(['draft', 'active', 'executeReady', 'executed'].some(status => status in stored.status), 'Unexpected proposal status');
  if (!('draft' in stored.status)) assert.equal(stored.instructionIndex, count, 'Incomplete proposal payload');
  const approved = stored.approved.map(String);
  assert.equal(new Set(approved).size, approved.length, 'Duplicate approvals');
  const eligible = phase === 'add' ? OWNERS : [...OWNERS, ...ADDED_OWNERS];
  assert(approved.every(address => eligible.includes(address)), 'Unexpected approver');
  if ('executeReady' in stored.status || 'executed' in stored.status) assert(approved.length >= 2, 'Threshold not met');
  if (stored.instructionIndex) {
    const attached = await readRpc('getMultipleAccounts', [Array.from({ length: stored.instructionIndex }, (_, i) => String(ixPda(txPda(plan, index), i + 1))), { encoding: 'base64', commitment: 'confirmed' }]);
    assert.equal(attached.value.length, stored.instructionIndex, 'Missing attached instructions');
    const expected = await actions(plan, phase);
    for (const [i, account] of attached.value.entries()) {
      assert.equal(account?.owner, String(PROGRAM));
      const decoded = coder.accounts.decode('MsInstruction', bytes(account));
      assert.equal(decoded.instructionIndex, i + 1);
      assert.deepEqual(encode({ programId: decoded.programId, keys: decoded.keys, data: decoded.data }), encode(expected[i]), 'Attached payload differs from test plan');
    }
  }
  return stored;
}
export async function next(owner, readRpc = rpc) {
  const rpc = readRpc;
  assert(OWNERS.includes(owner), 'Connect one of the two test owners');
  const p = await load('outputs/plan.json'); verifyPlan(p);
  const rehearsal = await load('outputs/rehearsal.json');
  assert.equal(rehearsal.status, 'PASSED'); assert.equal(rehearsal.planSha256, p.planSha256);
  assert.equal(await rpc('getGenesisHash'), GENESIS);
  const reference = await load('inputs/public-mainnet-reference.json');
  const response = await rpc('getMultipleAccounts', [[p.multisig, String(PROGRAM), reference.programDataAddress, String(txPda(p, 1)), String(txPda(p, 2)), p.vault], { commitment: 'confirmed', encoding: 'base64' }]);
  const [ms, program, pd, addTx, removeTx, vault] = response.value;
  verifyDeployment(p, reference, program, pd);
  const view = { plan: p, slot: response.context.slot, state: 'not created', phase: 'create', actionType: 'create', instructionCount: 1, attachedInstructions: 0, owners: [], threshold: 2, vaultSol: (vault?.lamports || 0) / 1e9, connected: owner, requiredOwner: OWNERS[0], title: '', transaction: null };
  let instructions;
  if (!ms) {
    assert(!addTx && !removeTx, 'Unexpected proposal without multisig');
    view.title = 'Create separate TEST ONLY multisig, 2 of 2';
    if (owner !== OWNERS[0]) { view.title = `Switch to browser wallet (${OWNERS[0]}) to create the test multisig`; return view; }
    instructions = [await sdk().buildCreateMultisig(2, key(p.createKey), OWNERS.map(key), p.label, 'No DAO assets or authorities. Both initial owners controlled by Demo.')];
  } else {
    assert.equal(ms.owner, String(PROGRAM));
    const state = msDecode(bytes(ms));
    view.owners = roster(state); view.threshold = state.threshold;
    assert.equal(state.threshold, 2, 'Unexpected threshold: stop');
    const added = await verifyProposal(p, 'add', addTx, rpc), removed = await verifyProposal(p, 'remove', removeTx, rpc);
    assert(!removed || (added && 'executed' in added.status), 'Removal proposal before completed additions');
    const expanded = equal(roster(state), [...OWNERS, ...p.addedOwners.map(x => x.address)]);
    const original = equal(roster(state), OWNERS);
    const final = equal(roster(state), finalRoster(p));
    assert(original || expanded || final, 'Unexpected owner set: stop');
    if (removed && 'executed' in removed.status) {
      assert(final && state.transactionIndex === 2, 'Unexpected final roster/index');
      Object.assign(view, { state: 'complete', phase: 'remove', actionType: 'complete', instructionCount: p.removedOwners.length, attachedInstructions: removed.instructionIndex, title: 'Complete: Fixture 2 and Fixture 3 removed; 2 of 8, both initial owners retained', requiredOwner: null });
      return view;
    }
    const phase = added && 'executed' in added.status ? 'remove' : 'add';
    assert(phase === 'remove' ? expanded : original, 'Unexpected phase/roster');
    const stored = phase === 'add' ? added : removed, index = phase === 'add' ? 1 : 2, transaction = txPda(p, index);
    assert.equal(state.transactionIndex, stored ? index : index - 1, 'Unreviewed proposal/index: stop');
    view.state = `${phase}: ${stored ? Object.keys(stored.status)[0] : 'not proposed'}`;
    view.approvals = stored?.approved.map(String) || [];
    const phaseCount = phaseOwners(p, phase).length;
    Object.assign(view, { phase, instructionCount: phaseCount, attachedInstructions: stored?.instructionIndex || 0 });
    if (!stored || 'draft' in stored.status) {
      view.actionType = 'upload';
      view.title = `${phase === 'add' ? 'Add eight committee owners' : 'Remove only Fixture 2 and Fixture 3'}: upload next packet (threshold stays 2)`;
      if (owner !== OWNERS[0]) { view.title = `Switch to browser wallet (${OWNERS[0]}) to propose/upload`; return view; }
      const peakRent = await rpc('getMinimumBalanceForRentExemption', [442]);
      const topUp = phase === 'add' ? Math.max(0, peakRent - ms.lamports) : 0;
      assert(topUp <= 10000000, 'Unexpected rent top-up');
      instructions = (await staging(p, phase, { created: Boolean(stored), attached: stored?.instructionIndex || 0, topUp }))[0];
    } else if ('active' in stored.status) {
      view.actionType = 'approve';
      assert.equal(stored.instructionIndex, phaseCount);
      const required = OWNERS.find(k => !view.approvals.includes(k));
      assert(required); view.requiredOwner = required;
      view.title = `Approve ${phase} proposal with ${required}; ${view.approvals.length}/2 approvals`;
      if (owner !== required) return view;
      instructions = [await sdk(owner).buildApproveTransaction(key(p.multisig), transaction)];
    } else {
      view.actionType = 'execute';
      assert('executeReady' in stored.status && stored.approved.length >= 2);
      assert.equal(stored.instructionIndex, phaseCount);
      view.requiredOwner = owner; view.title = `Execute ${phase} of ${phaseCount} committee owners atomically, threshold stays 2`;
      instructions = [await executeIx(p, phase, owner)];
    }
  }
  const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = packet(instructions, owner, latest.value.blockhash);
  assert(tx.instructions.every(ix => !ix.keys.some(k => FORBIDDEN.includes(String(k.pubkey)))), 'Real DAO account touched');
  const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  assert(unsigned.length <= 1232);
  const messageBase64 = tx.serializeMessage().toString('base64');
  const fee = await rpc('getFeeForMessage', [messageBase64, { commitment: 'confirmed' }]);
  assert(fee.value !== null && fee.value <= 1000000, 'Unexpected fee');
  const simulation = await rpc('simulateTransaction', [unsigned.toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: false }]);
  view.preflight = { error: simulation.value.err, logs: simulation.value.logs, units: simulation.value.unitsConsumed };
  view.feeSol = fee.value / 1e9;
  if (simulation.value.err) { view.title += ' — preflight FAILED, do not sign'; return view; }
  view.transaction = unsigned.toString('base64'); view.messageSha256 = sha(tx.serializeMessage()); view.lastValidBlockHeight = latest.value.lastValidBlockHeight;
  return view;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2] || 'inspect';
  if (command === 'prepare') await prepare();
  else if (command === 'inspect') { const p = await load('outputs/plan.json'); verifyPlan(p); console.log(JSON.stringify(p, null, 2)); }
  else if (command === 'next') console.log(JSON.stringify(await next(process.argv[3] || OWNERS[0]), null, 2));
  else throw Error('Use prepare, inspect or next [public-owner-address]. No CLI signing/broadcast is provided.');
}
