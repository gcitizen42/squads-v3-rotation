import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load, OLD, PROGRAM, GENESIS, OWNERS, key, sdk, bytes, packet, msDecode, roster, LiteSVM, FailedTransactionMetadata, Rent, SystemProgram, Transaction } from './sandbox.mjs';
import { TEST_MS, validateDesired, buildActions, configHash, prepareDesired, nextDesired, desiredBatches, desiredExecute, overview } from './desired.mjs';
const frozen = await load('outputs/plan.json'), reference = await load('inputs/public-mainnet-reference.json'), elf = await readFile(new URL('sources/squads-mainnet.so', OLD));
const fredy = frozen.removedOwners[1].address, john = frozen.addedOwners[0].address, piotr = frozen.addedOwners[3].address;
async function environment(custom = false) {
  const createKey = custom ? key(john) : key(frozen.createKey);
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('package.json', OLD));
  const TEST_MS = custom ? String(require('@sqds/sdk').getMsPDA(createKey, PROGRAM)[0]) : frozen.multisig;
  const vm = new LiteSVM().withSigverify(false).withTransactionHistory(0n), rent = bytes(reference.rent);
  vm.setRent(new Rent(rent.readBigUInt64LE(0), rent.readDoubleLE(8), rent[16]));
  vm.addProgramWithLoader(PROGRAM, elf, key('BPFLoaderUpgradeab1e11111111111111111111111'));
  for (const owner of OWNERS) vm.setAccount(key(owner), { lamports: 1000000000, owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false });
  const send = (instructions, owner) => { const result = vm.sendTransaction(packet(instructions, owner, vm.latestBlockhash())); assert(!(result instanceof FailedTransactionMetadata), result instanceof FailedTransactionMetadata ? String(result.err()) : ''); };
  send([await sdk().buildCreateMultisig(2, createKey, OWNERS.map(key), 'Synthetic test', 'Not on chain')], OWNERS[0]);
  const before = msDecode(vm.getAccount(key(TEST_MS)).data), built = await buildActions(before, [...OWNERS, fredy], 2, TEST_MS);
  const manual = { multisig: TEST_MS, index: 1, proposer: OWNERS[0], topUp: Number(vm.minimumBalanceForRentExemption(442n)), ...built };
  for (const batch of await desiredBatches(manual)) send(batch, OWNERS[0]);
  const { proposalAddress } = await import('./desired.mjs');
  send([await sdk(OWNERS[1]).buildApproveTransaction(key(TEST_MS), proposalAddress(1, TEST_MS))], OWNERS[1]);
  send([await desiredExecute(manual, OWNERS[1])], OWNERS[1]);
  const wrap = row => row ? { data: [Buffer.from(row.data).toString('base64'), 'base64'], owner: String(row.owner), lamports: Number(row.lamports), executable: row.executable } : null;
  const pd = Buffer.concat([Buffer.alloc(45), elf]); pd.writeUInt32LE(3, 0);
  const program = Buffer.concat([Buffer.from([2, 0, 0, 0]), key(reference.programDataAddress).toBuffer()]);
  const info = address => address === String(PROGRAM) ? wrap({ data: program, owner: key('BPFLoaderUpgradeab1e11111111111111111111111'), lamports: 1, executable: true }) : address === reference.programDataAddress ? wrap({ data: pd, owner: key('BPFLoaderUpgradeab1e11111111111111111111111'), lamports: 1, executable: false }) : wrap(vm.getAccount(key(address)));
  const rpc = async (method, args) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: args[0].map(info) };
    if (method === 'getAccountInfo') return { context: { slot: 1 }, value: info(args[0]) };
    if (method === 'getMinimumBalanceForRentExemption') return Number(vm.minimumBalanceForRentExemption(BigInt(args[0])));
    if (method === 'getLatestBlockhash') return { value: { blockhash: vm.latestBlockhash(), lastValidBlockHeight: 1000 } };
    if (method === 'getFeeForMessage') return { value: 5000 };
    if (method === 'simulateTransaction') { const result = vm.simulateTransaction(Transaction.from(Buffer.from(args[0], 'base64'))); return { value: { err: result instanceof FailedTransactionMetadata ? String(result.err()) : null } }; }
    throw Error('Unexpected/write RPC ' + method);
  };
  return { vm, rpc, send, multisig: TEST_MS };
}
test('Desired members reject duplicates, bad threshold, missing personal wallets and PDA keys', () => {
  assert.throws(() => validateDesired([...OWNERS, OWNERS[0]], 2), /Duplicate/);
  assert.throws(() => validateDesired(OWNERS, 3), /Threshold/);
  assert.throws(() => validateDesired([OWNERS[0], john], 2), /BOTH/);
  assert.throws(() => validateDesired([...OWNERS, TEST_MS], 2), /on-curve/);
});
test('Unknown signer rejected before any RPC', async () => { await assert.rejects(prepareDesired({ proposer: john }), /wallet/); });
test('Live manual addition appears in history without assuming old fixed roster', async () => {
  const { rpc } = await environment(), view = await overview(OWNERS[1], rpc);
  assert.equal(view.owners.length, 3); assert(view.owners.some(row => row.address === fredy));
  const manual = view.proposals.find(row => row.index === 1 && !row.local);
  assert.equal(manual.status, 'executed'); assert.equal(manual.planId, null); assert.equal(manual.availableAction, null);
});
test('No-op proposal and unacknowledged external quorum are rejected', async () => {
  const { rpc } = await environment();
  await assert.rejects(prepareDesired({ proposer: OWNERS[0], members: [...OWNERS, fredy], threshold: 2 }, rpc, async () => {}), /No changes/);
  await assert.rejects(prepareDesired({ proposer: OWNERS[0], members: [...OWNERS, fredy], threshold: 3 }, rpc, async () => {}), /other members/);
});
test('An active proposal blocks preparing a competing owner change', async () => {
  const { rpc, vm } = await environment();
  const record = await prepareDesired({ proposer: OWNERS[0], members: [...OWNERS, john], threshold: 2 }, rpc, async () => {});
  const view = await nextDesired(record.id, OWNERS[0], rpc, async () => record);
  const result = vm.sendTransaction(Transaction.from(Buffer.from(view.transaction, 'base64'))); assert(!(result instanceof FailedTransactionMetadata));
  await assert.rejects(prepareDesired({ proposer: OWNERS[0], members: [...OWNERS, piotr], threshold: 2 }, rpc, async () => {}), /pending/);
});
for (const threshold of [1, 2, 3]) test('Desired roster + threshold ' + threshold + ' rehearses and executes atomically from manually changed state', async () => {
  const { rpc, vm } = await environment(), desired = [...OWNERS, john, piotr];
  let record;
  record = await prepareDesired({ proposer: OWNERS[0], members: desired, threshold, ackExternalQuorum: threshold > 2 }, rpc, async row => { record = row; });
  assert.equal(record.rehearsal.status, 'PASSED'); assert.equal(record.spec.previousOwners.length, 3);
  const before = configHash(msDecode(vm.getAccount(key(TEST_MS)).data));
  let owner = OWNERS[0], execution = 0;
  for (let i = 0; i < 10; i++) {
    let view;
    try { view = await nextDesired(record.id, owner, rpc, async () => record); }
    catch (error) { if (/already recorded|original proposer/.test(error.message)) { owner = owner === OWNERS[0] ? OWNERS[1] : OWNERS[0]; continue; } throw error; }
    if (view.state === 'complete') { assert.equal(execution, 1); break; }
    assert(view.transaction);
    if (view.actionType !== 'execute') assert.equal(configHash(msDecode(vm.getAccount(key(TEST_MS)).data)), before);
    if (view.actionType === 'execute') execution++;
    const result = vm.sendTransaction(Transaction.from(Buffer.from(view.transaction, 'base64'))); assert(!(result instanceof FailedTransactionMetadata), String(result));
    if (view.actionType === 'upload') owner = OWNERS[1];
  }
  const after = msDecode(vm.getAccount(key(TEST_MS)).data); assert.deepEqual(roster(after), [...desired].sort()); assert.equal(after.threshold, threshold);
});
test('Stale or rehashed non-membership payload fails before a signing request', async () => {
  const { rpc, vm, send } = await environment();
  const record = await prepareDesired({ proposer: OWNERS[0], members: [...OWNERS, john], threshold: 2 }, rpc, async () => {});
  const changed = structuredClone(record); changed.spec.actions[0].programId = String(SystemProgram.programId);
  const { sha } = await import('./sandbox.mjs'); changed.id = sha(JSON.stringify(changed.spec)); changed.rehearsal.planSha256 = changed.id;
  await assert.rejects(nextDesired(changed.id, OWNERS[0], rpc, async () => changed), /canonical/);
  const state = msDecode(vm.getAccount(key(TEST_MS)).data); state.threshold = 1;
  const data = await coderEncode(state); const old = vm.getAccount(key(TEST_MS)); vm.setAccount(key(TEST_MS), { ...old, data });
  await assert.rejects(nextDesired(record.id, OWNERS[0], rpc, async () => record), /Configuration changed/);
});
async function coderEncode(state) { const { coder } = await import('./sandbox.mjs'); return coder.accounts.encode('Ms', state); }
test('Custom multisig: read-only nonmember, canonical address binding, real-program full rotation', async () => {
  const { rpc, vm, multisig } = await environment(true);
  const view = await overview(john, rpc, multisig);
  assert.equal(view.canSign, false); assert.equal(view.multisig, multisig);
  await assert.rejects(prepareDesired({ multisig, proposer: john, members: [john, piotr], threshold: 2 }, rpc, async () => {}), /NOT a current member/);
  const record = await prepareDesired({ multisig, proposer: OWNERS[0], members: [OWNERS[0], john], threshold: 2 }, rpc, async () => {});
  assert.equal(record.spec.multisig, multisig);
  assert(record.spec.actions.every(ix => ix.keys[0].pubkey === multisig));
  let owner = OWNERS[0], executed = false;
  for (let i = 0; i < 12; i++) {
    let next;
    try { next = await nextDesired(record.id, owner, rpc, async () => record); }
    catch (error) { if (/already recorded|original proposer/.test(error.message)) { owner = OWNERS[1]; continue; } throw error; }
    const result = vm.sendTransaction(Transaction.from(Buffer.from(next.transaction, 'base64')));
    assert(!(result instanceof FailedTransactionMetadata));
    if (next.actionType === 'execute') { executed = true; break; }
    owner = OWNERS[1];
  }
  assert(executed); assert.deepEqual(roster(msDecode(vm.getAccount(key(multisig)).data)), [OWNERS[0], john].sort());
  assert(!vm.getAccount(key(TEST_MS)), 'Default test multisig must never be touched');
});
test('Custom address cannot alias a different PDA/account', async () => {
  const { rpc } = await environment(true);
  await assert.rejects(overview(null, async (method, args) => {
    const result = await rpc(method, args);
    if (method === 'getMultipleAccounts' && args[0].includes(TEST_MS)) {
      const { rpc: otherRpc, multisig } = await environment(true);
      result.value[0] = (await otherRpc('getAccountInfo', [multisig])).value;
    }
    return result;
  }), /PDA verification/);
});
