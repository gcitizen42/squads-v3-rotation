import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { load, save, ROOT, OLD, PROGRAM, GENESIS, OWNERS, sdk, key, sha, rpc, bytes, msDecode, txDecode, roster, coder, encode, packet, pack, ixPda, verifyPlan, verifyDeployment, LiteSVM, Rent, SystemProgram, FailedTransactionMetadata, Transaction } from './sandbox.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('package.json', OLD)), { getTxPDA, getMsPDA } = require('@sqds/sdk'), BN = require('bn.js');
export const proposalAddress = (index, multisig = TEST_MS) => getTxPDA(key(multisig), new BN(index), PROGRAM)[0];
export const TEST_MS = 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES';
export const configHash = state => sha(JSON.stringify({ owners: roster(state), threshold: state.threshold, changeIndex: state.msChangeIndex, createKey: String(state.createKey) }));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function validateDesired(members, threshold, multisig = TEST_MS) {
  assert(Array.isArray(members) && members.length >= 2 && members.length <= 32, 'Provide 2 to 32 desired members');
  const addresses = members.map(value => { assert(typeof value === 'string', 'Each member must be a public address'); const address = value.trim(); assert.equal(String(key(address)), address, 'Invalid public address'); assert(key(address).constructor.isOnCurve(key(address).toBytes()), 'Member must be an on-curve public key'); return address; });
  assert.equal(new Set(addresses).size, addresses.length, 'Duplicate member address');
  if (multisig === TEST_MS) assert(OWNERS.every(address => addresses.includes(address)), 'For this test retain BOTH your personal wallets');
  assert(Number.isInteger(threshold) && threshold >= 1 && threshold <= addresses.length, 'Threshold must be an integer from 1 to the member count');
  return addresses;
}
export async function liveState(readRpc = rpc, multisig = TEST_MS) {
  const target = String(key(multisig));
  const frozen = await load('outputs/plan.json'); verifyPlan(frozen); assert.equal(frozen.multisig, TEST_MS);
  assert.equal(await readRpc('getGenesisHash'), GENESIS);
  const reference = await load('inputs/public-mainnet-reference.json');
  const result = await readRpc('getMultipleAccounts', [[target, String(PROGRAM), reference.programDataAddress, String(sdk().getAuthorityPDA(key(target), 1))], { commitment: 'confirmed', encoding: 'base64' }]);
  const [account, program, data, vault] = result.value; verifyDeployment(frozen, reference, program, data);
  assert(account && account.owner === String(PROGRAM), 'Existing Squads v3 multisig not found');
  const state = msDecode(bytes(account));
  assert.equal(String(getMsPDA(state.createKey, PROGRAM)[0]), target, 'Multisig PDA verification failed');
  assert(state.keys.length >= 2 && state.keys.length <= 32 && state.threshold >= 1 && state.threshold <= state.keys.length, 'Unexpected configuration');
  assert(Number.isInteger(state.transactionIndex) && state.transactionIndex >= 0 && state.transactionIndex < 100000, 'Unexpected proposal index');
  if (target === TEST_MS) assert(OWNERS.every(address => roster(state).includes(address)), 'Personal test wallets no longer both present. Review manually.');
  return { multisig: target, vault: String(sdk().getAuthorityPDA(key(target), 1)), frozen, reference, account, state, slot: result.context.slot, vaultSol: (vault?.lamports || 0) / 1e9 };
}
async function storedProposal(index, readRpc, multisig = TEST_MS, cachedAccount, cachedInstructions) {
  const TEST_MS = multisig;
  const response = cachedAccount !== undefined ? { value: cachedAccount } : await readRpc('getAccountInfo', [String(proposalAddress(index, TEST_MS)), { commitment: 'confirmed', encoding: 'base64' }]);
  if (!response.value) return null;
  assert.equal(response.value.owner, String(PROGRAM)); const state = txDecode(bytes(response.value));
  assert(state.ms.equals(key(TEST_MS))); assert.equal(state.transactionIndex, index);
  const instructions = [];
  if (state.instructionIndex) {
    assert(state.instructionIndex <= 255);
    for (let start = 0; start < state.instructionIndex; start += 80) {
      const addresses = Array.from({ length: Math.min(80, state.instructionIndex - start) }, (_, i) => String(ixPda(proposalAddress(index, TEST_MS), start + i + 1)));
      const accounts = cachedInstructions ? { value: addresses.map(address => cachedInstructions.get(address)) } : await readRpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
      for (const [i, info] of accounts.value.entries()) {
        assert.equal(info?.owner, String(PROGRAM)); const ix = coder.accounts.decode('MsInstruction', bytes(info));
        assert.equal(ix.instructionIndex, start + i + 1); instructions.push(encode({ programId: ix.programId, keys: ix.keys, data: ix.data }));
      }
    }
  }
  return { state, instructions };
}
async function planFiles() {
  let names; try { names = await readdir(new URL('outputs/desired-plans/', ROOT)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const file of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(-200)) result.push(await load('outputs/desired-plans/' + file));
  return result;
}
export function verifyDesiredPlan(record) {
  const { spec, id, rehearsal } = record;
  assert.equal(id, sha(JSON.stringify(spec)), 'Saved proposal changed');
  assert.equal(String(key(spec.multisig)), spec.multisig); assert.equal(spec.program, String(PROGRAM)); assert.equal(spec.genesis, GENESIS);
  if (spec.multisig === TEST_MS) assert(OWNERS.includes(spec.proposer)); validateDesired(spec.members, spec.threshold, spec.multisig);
  assert(spec.previousOwners.includes(spec.proposer));
  assert(spec.members.includes(spec.proposer), 'Retain the proposing wallet');
  if (spec.multisig === TEST_MS && spec.threshold > OWNERS.length) assert.equal(spec.externalQuorumAcknowledged, true, 'External quorum risk not acknowledged');
  assert(Number.isInteger(spec.index) && spec.index === spec.baselineIndex + 1);
  assert(Number.isSafeInteger(spec.topUp) && spec.topUp >= 0 && spec.topUp <= 20000000);
  assert.equal(rehearsal.status, 'PASSED'); assert.equal(rehearsal.planSha256, id);
}
export async function desiredRecord(id) {
  assert(/^[a-f0-9]{64}$/.test(id || ''), 'Invalid plan hash');
  const record = await load('outputs/desired-plans/' + id + '.json'); verifyDesiredPlan(record); return record;
}
export async function overview(owner = null, readRpc = rpc, multisig = TEST_MS) {
  const TEST_MS = String(key(multisig));
  if (owner !== null) key(owner);
  const live = await liveState(readRpc, TEST_MS), records = (await planFiles()).filter(row => row.spec.multisig === TEST_MS), history = [];
  const first = Math.max(1, live.state.transactionIndex - 49);
  const indices = Array.from({ length: Math.max(0, live.state.transactionIndex - first + 1) }, (_, i) => live.state.transactionIndex - i);
  const metadata = indices.length ? (await readRpc('getMultipleAccounts', [indices.map(index => String(proposalAddress(index, TEST_MS))), { encoding: 'base64', commitment: 'confirmed' }])).value : [];
  const instructionAddresses = [];
  metadata.forEach((account, i) => {
    if (!account) return;
    assert.equal(account.owner, String(PROGRAM));
    const stored = txDecode(bytes(account)); assert(stored.instructionIndex <= 255);
    for (let n = 1; n <= stored.instructionIndex; n++) instructionAddresses.push(String(ixPda(proposalAddress(indices[i], TEST_MS), n)));
  });
  assert(instructionAddresses.length <= 2000, 'History too large for a bounded read. Use a smaller history window.');
  const cached = new Map();
  for (let start = 0; start < instructionAddresses.length; start += 80) {
    const addresses = instructionAddresses.slice(start, start + 80);
    const accounts = await readRpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
    addresses.forEach((address, i) => cached.set(address, accounts.value[i]));
  }
  for (let index = live.state.transactionIndex; index >= first; index--) {
    const found = await storedProposal(index, readRpc, TEST_MS, metadata[live.state.transactionIndex - index], cached); if (!found) continue;
    const status = Object.keys(found.state.status)[0], approvals = found.state.approved.map(String);
    const record = records.find(row => {
      try { verifyDesiredPlan(row); return row.spec.index === index && row.spec.proposer === String(found.state.creator) && found.instructions.length <= row.spec.actions.length && found.instructions.every((ix, i) => JSON.stringify(ix) === JSON.stringify(row.spec.actions[i])); } catch { return false; }
    });
    const stale = !['executed', 'rejected', 'cancelled'].includes(status) && index <= live.state.msChangeIndex;
    const actions = found.instructions.map(ix => {
      try {
        if (ix.programId !== String(PROGRAM)) return { kind: 'External program (read-only)', address: ix.programId };
        const decoded = coder.instruction.decode(Buffer.from(ix.dataBase64, 'base64'));
        return { kind: decoded.name, address: String(decoded.data.newMember || decoded.data.oldMember || ''), threshold: decoded.data.newThreshold };
      } catch { return { kind: 'Undecoded (read-only)' }; }
    });
    let availableAction = null;
    if (record && owner && roster(live.state).includes(owner) && !stale && configHash(live.state) === record.spec.baselineHash) {
      if (status === 'draft' && owner === record.spec.proposer) availableAction = 'upload';
      else if (status === 'active' && !approvals.includes(owner)) availableAction = 'approve';
      else if (status === 'executeReady' && approvals.length >= live.state.threshold) availableAction = 'execute';
    }
    history.push({ index, address: String(proposalAddress(index, TEST_MS)), status, stale, creator: String(found.state.creator), approvals, threshold: record?.spec.previousThreshold || (['draft', 'active', 'executeReady'].includes(status) && !stale ? live.state.threshold : null), yourVote: owner ? approvals.includes(owner) ? 'Approved' : 'Not voted' : 'Not connected', actions, instructionCount: record?.spec.actions.length || found.instructions.length, attachedInstructions: found.instructions.length, planId: record?.id || null, availableAction, local: false });
  }
  for (const record of records) {
    verifyDesiredPlan(record);
    if (history.some(row => row.planId === record.id) || record.spec.index <= live.state.transactionIndex) continue;
    const current = record.spec.baselineHash === configHash(live.state) && record.spec.index === live.state.transactionIndex + 1;
    history.unshift({ index: record.spec.index, address: String(proposalAddress(record.spec.index, TEST_MS)), status: current ? 'Prepared locally / not submitted' : 'Outdated local draft', creator: record.spec.proposer, createdAt: record.createdAt, approvals: [], threshold: record.spec.previousThreshold, yourVote: 'Not submitted', actions: record.spec.summary, instructionCount: record.spec.actions.length, attachedInstructions: 0, planId: record.id, availableAction: current && owner === record.spec.proposer && roster(live.state).includes(owner) ? 'upload' : null, local: true });
  }
  history.sort((a, b) => b.index - a.index || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const names = new Map([...live.frozen.addedOwners, { address: OWNERS[0], name: 'Your browser wallet' }, { address: OWNERS[1], name: 'Your committee Ledger' }].map(row => [row.address, row.name]));
  return { planSha256: live.frozen.planSha256, slot: live.slot, multisig: TEST_MS, vault: live.vault, threshold: live.state.threshold, owners: roster(live.state).map(address => ({ address, name: names.get(address) || 'Member' })), connected: owner, vaultSol: live.vaultSol, proposals: history, latestIndex: live.state.transactionIndex, historyFrom: first, canSign: owner !== null && roster(live.state).includes(owner), externalStateChanges: true };
}
export async function buildActions(state, members, threshold, multisig = TEST_MS) {
  const TEST_MS = multisig;
  const methods = sdk().multisig.methods, current = roster(state), summary = [], actions = [];
  const append = async (kind, value) => {
    const method = kind === 'addMember' ? methods.addMember(key(value)) : kind === 'removeMember' ? methods.removeMember(key(value)) : methods.changeThreshold(value);
    actions.push(encode(await method.accounts({ multisig: key(TEST_MS) }).instruction()));
    summary.push(kind === 'changeThreshold' ? { kind, threshold: value } : { kind, address: value });
  };
  for (const address of members.filter(address => !current.includes(address))) await append('addMember', address);
  if (threshold < state.threshold) await append('changeThreshold', threshold);
  for (const address of current.filter(address => !members.includes(address))) await append('removeMember', address);
  if (threshold > state.threshold) await append('changeThreshold', threshold);
  assert(actions.length, 'No changes: the desired members and threshold already match');
  return { actions, summary };
}
const restore = row => new (require('@solana/web3.js').TransactionInstruction)({ programId: key(row.programId), keys: row.keys.map(k => ({ ...k, pubkey: key(k.pubkey) })), data: Buffer.from(row.dataBase64, 'base64') });
export async function desiredExecute(spec, owner) {
  const TEST_MS = spec.multisig || 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES';
  const expanded = spec.actions.flatMap((row, i) => {
    const ix = restore(row); return [{ pubkey: ixPda(proposalAddress(spec.index, TEST_MS), i + 1), isSigner: false, isWritable: false }, { pubkey: PROGRAM, isSigner: false, isWritable: false }, ...ix.keys.map(k => ({ ...k, isSigner: false }))];
  });
  const unique = [], indices = expanded.map(k => { let i = unique.findIndex(old => old.pubkey.equals(k.pubkey) && old.isWritable === k.isWritable); if (i < 0) { i = unique.length; unique.push(k); } return i; });
  const ix = await sdk(owner).multisig.methods.executeTransaction(Buffer.from(indices)).accounts({ multisig: key(TEST_MS), transaction: proposalAddress(spec.index, TEST_MS), member: key(owner) }).instruction(); ix.keys.push(...unique); return ix;
}
export async function desiredBatches(spec, { created = false, attached = 0, topUp = spec.topUp } = {}) {
  const TEST_MS = spec.multisig || 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES';
  const client = sdk(spec.proposer), tx = proposalAddress(spec.index, TEST_MS), instructions = [];
  if (topUp) instructions.push(SystemProgram.transfer({ fromPubkey: key(spec.proposer), toPubkey: key(TEST_MS), lamports: topUp }));
  if (!created) instructions.push(await client.buildCreateTransaction(key(TEST_MS), 0, spec.index));
  for (let i = attached; i < spec.actions.length; i++) instructions.push(await client.buildAddInstruction(key(TEST_MS), tx, restore(spec.actions[i]), i + 1));
  instructions.push(await client.buildActivateTransaction(key(TEST_MS), tx), await client.buildApproveTransaction(key(TEST_MS), tx));
  return pack(instructions, spec.proposer);
}
async function rehearse(spec, live) {
  const TEST_MS = spec.multisig || 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES';
  const elf = await readFile(new URL('sources/squads-mainnet.so', OLD)); assert.equal(sha(elf), live.frozen.programElfSha256);
  const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n), rent = bytes(live.reference.rent);
  svm.setRent(new Rent(rent.readBigUInt64LE(0), rent.readDoubleLE(8), rent[16]));
  assert.equal(Number(svm.minimumBalanceForRentExemption(BigInt(spec.peakBytes))), spec.rent);
  svm.addProgramWithLoader(PROGRAM, elf, key('BPFLoaderUpgradeab1e11111111111111111111111'));
  svm.setAccount(key(TEST_MS), { data: bytes(live.account), owner: PROGRAM, lamports: live.account.lamports, executable: false, rentEpoch: 18446744073709551615n });
  for (const owner of roster(live.state)) svm.setAccount(key(owner), { lamports: 1000000000, owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false });
  let count = 0;
  const send = (instructions, owner) => { const result = svm.sendTransaction(packet(instructions, owner, svm.latestBlockhash())); assert(!(result instanceof FailedTransactionMetadata), result instanceof FailedTransactionMetadata ? 'Local rehearsal failed: ' + String(result.err()) : ''); count++; };
  const batches = await desiredBatches(spec);
  for (const batch of batches) send(batch, spec.proposer);
  assert.equal(configHash(msDecode(svm.getAccount(key(TEST_MS)).data)), spec.baselineHash, 'Upload must not change membership');
  for (const owner of roster(live.state).filter(address => address !== spec.proposer).slice(0, live.state.threshold - 1)) send([await sdk(owner).buildApproveTransaction(key(TEST_MS), proposalAddress(spec.index, TEST_MS))], owner);
  send([await desiredExecute(spec, spec.proposer)], spec.proposer);
  const after = msDecode(svm.getAccount(key(TEST_MS)).data);
  assert(same(roster(after), spec.members)); assert.equal(after.threshold, spec.threshold);
  return { status: 'PASSED', planSha256: sha(JSON.stringify(spec)), uploadPackets: batches.length, oldQuorum: live.state.threshold, successfulSyntheticTransactions: count, finalOwners: roster(after), finalThreshold: after.threshold, signatureVerificationDisabled: true, submitted: false };
}
export async function prepareDesired(input, readRpc = rpc, persist = record => save('outputs/desired-plans/' + record.id + '.json', record)) {
  const TEST_MS = input.multisig ? String(key(input.multisig)) : 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES';
  if (TEST_MS === 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES') assert(OWNERS.includes(input.proposer), 'Use your browser or Ledger test wallet');
  const members = validateDesired(input.members, input.threshold, TEST_MS), live = await liveState(readRpc, TEST_MS);
  assert(roster(live.state).includes(input.proposer), 'Connected wallet is NOT a current member. Wait for the membership change to execute.');
  assert(members.includes(input.proposer), 'Retain the proposing wallet in the desired roster');
  assert(live.state.transactionIndex - live.state.msChangeIndex <= 50, 'More than 50 potentially live proposals. Review the complete queue before preparing.');
  if (TEST_MS === 'Fy49skTib3JjjhEvYqpJNBV7A9P5ffcHKMYhKBzzs3ES' && input.threshold > OWNERS.length) assert(input.ackExternalQuorum === true, 'A threshold above two requires other members to sign future proposals. Acknowledge this risk.');
  const currentHistory = await overview(input.proposer, readRpc, TEST_MS);
  assert(!currentHistory.proposals.some(row => !row.local && !row.stale && ['draft', 'active', 'executeReady'].includes(row.status)), 'An on-chain proposal is pending. Finish or resolve it before preparing a replacement.');
  const built = await buildActions(live.state, members, input.threshold, TEST_MS);
  let capacity = Math.floor((bytes(live.account).length - 58) / 32), peakBytes = bytes(live.account).length, count = live.state.keys.length;
  for (const row of built.summary.filter(row => row.kind === 'addMember')) { if (count >= capacity) { capacity += 10; peakBytes += 320; } count++; }
  const rent = await readRpc('getMinimumBalanceForRentExemption', [peakBytes]), topUp = Math.max(0, rent - live.account.lamports);
  assert(topUp <= 20000000, 'Unexpected configuration rent top-up');
  const spec = { multisig: TEST_MS, program: String(PROGRAM), genesis: GENESIS, baselineHash: configHash(live.state), previousOwners: roster(live.state), previousThreshold: live.state.threshold, baselineIndex: live.state.transactionIndex, index: live.state.transactionIndex + 1, proposer: input.proposer, members, threshold: input.threshold, actions: built.actions, summary: built.summary, peakBytes, rent, topUp, externalQuorumAcknowledged: input.ackExternalQuorum === true };
  const execute = packet([await desiredExecute(spec, input.proposer)], input.proposer, '11111111111111111111111111111111');
  assert(execute.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232, 'Atomic execution exceeds Solana packet size. Reduce the scope.');
  const proof = await rehearse(spec, live), record = { id: sha(JSON.stringify(spec)), spec, rehearsal: proof, createdAt: new Date().toISOString() };
  verifyDesiredPlan(record); await persist(record); return record;
}
export async function nextDesired(id, owner, readRpc = rpc, readRecord = desiredRecord) {
  const record = await readRecord(id); verifyDesiredPlan(record); const { spec } = record, TEST_MS = spec.multisig, live = await liveState(readRpc, TEST_MS);
  assert(roster(live.state).includes(owner), 'Connected wallet is NOT a current member');
  const canonical = await buildActions({ keys: spec.previousOwners.map(key), threshold: spec.previousThreshold }, spec.members, spec.threshold, TEST_MS);
  assert.deepEqual(spec.actions, canonical.actions, 'Saved actions are not the canonical desired membership changes');
  assert.deepEqual(spec.summary, canonical.summary);
  const stored = await storedProposal(spec.index, readRpc, TEST_MS);
  if (stored) {
    assert.equal(stored.state.authorityIndex, 0); assert.equal(String(stored.state.creator), spec.proposer);
    assert(stored.instructions.length <= spec.actions.length);
    stored.instructions.forEach((row, i) => assert.deepEqual(row, spec.actions[i], 'Stored proposal differs from reviewed plan'));
    assert(['draft', 'active', 'executeReady', 'executed'].some(status => status in stored.state.status), 'Proposal is rejected or cancelled');
    if (!('draft' in stored.state.status)) assert.equal(stored.instructions.length, spec.actions.length);
  }
  const approvals = stored?.state.approved.map(String) || [];
  const view = { plan: live.frozen, review: record, desiredPlanId: id, phase: 'desired', actionType: null, state: stored ? Object.keys(stored.state.status)[0] : 'not proposed', title: '', owners: roster(live.state), threshold: live.state.threshold, approvalThreshold: spec.previousThreshold, approvals, requiredOwner: owner, transaction: null };
  if (stored && 'executed' in stored.state.status) {
    assert(same(roster(live.state), spec.members) && live.state.threshold === spec.threshold);
    return { ...view, state: 'complete', title: 'Executed: desired owners and threshold verified', requiredOwner: null };
  }
  assert.equal(configHash(live.state), spec.baselineHash, 'Configuration changed. Rebuild from live state.');
  assert(same(roster(live.state), spec.previousOwners) && live.state.threshold === spec.previousThreshold, 'Baseline review fields do not match live state');
  assert.equal(live.state.transactionIndex, stored ? spec.index : spec.baselineIndex, 'Competing proposal index. Review history.');
  assert(!stored || stored.state.transactionIndex > live.state.msChangeIndex, 'Stale proposal');
  assert(approvals.every(address => spec.previousOwners.includes(address)) && new Set(approvals).size === approvals.length);
  let instructions;
  if (!stored || 'draft' in stored.state.status) {
    Object.assign(view, { actionType: 'upload', title: 'Upload next desired-owner proposal packet', requiredOwner: spec.proposer });
    assert.equal(owner, spec.proposer, 'Only the original proposer can upload');
    const topUp = Math.max(0, spec.rent - live.account.lamports); assert(topUp <= spec.topUp);
    instructions = (await desiredBatches(spec, { created: Boolean(stored), attached: stored?.instructions.length || 0, topUp }))[0];
  } else if ('active' in stored.state.status) {
    assert(!approvals.includes(owner), 'Your approval is already recorded');
    Object.assign(view, { actionType: 'approve', title: 'Approve reviewed desired owners and threshold' });
    instructions = [await sdk(owner).buildApproveTransaction(key(TEST_MS), proposalAddress(spec.index, TEST_MS))];
  } else {
    assert('executeReady' in stored.state.status && approvals.length >= spec.previousThreshold, 'Current quorum not met');
    Object.assign(view, { actionType: 'execute', title: 'Execute all reviewed owner and threshold changes atomically' }); instructions = [await desiredExecute(spec, owner)];
  }
  const latest = await readRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), tx = packet(instructions, owner, latest.value.blockhash);
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false }); assert(raw.length <= 1232);
  const fee = await readRpc('getFeeForMessage', [tx.serializeMessage().toString('base64'), { commitment: 'confirmed' }]); assert(Number.isSafeInteger(fee.value) && fee.value >= 0 && fee.value <= 1000000);
  const preflight = await readRpc('simulateTransaction', [raw.toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  assert.equal(preflight.value.err, null, 'Unsigned preflight failed: ' + JSON.stringify(preflight.value.err));
  return { ...view, transaction: raw.toString('base64'), messageSha256: sha(tx.serializeMessage()), feeSol: fee.value / 1e9, preflight: { error: null }, lastValidBlockHeight: latest.value.lastValidBlockHeight };
}
