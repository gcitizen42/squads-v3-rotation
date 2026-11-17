import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { management } from './management.mjs';
import { next, verifyPlan, load, OLD, PROGRAM, GENESIS, OWNERS, finalRoster, key, bytes, sha, LiteSVM, Rent, SystemProgram, FailedTransactionMetadata, Transaction } from './sandbox.mjs';

const p = await load('outputs/plan.json'), reference = await load('inputs/public-mainnet-reference.json');
test('Browser wallet proposes and funds account rent; committee Ledger is second approver', () => {
  assert.equal(OWNERS[0], 'CqgQWBP92uTRahafsg4urinSgLbMDZEDk31RnzM5LL9M');
  assert.equal(OWNERS[1], 'G7Eawo4c77kVYJqSAB6rMzv7d2Jy3hQu5X5BitRgcaeP');
  assert.deepEqual(p.owners, OWNERS);
});
test('Plan is isolated; exactly two private-owner roles and eight public committee additions', () => { verifyPlan(p); assert.equal(p.addedOwners.length, 8); assert(!p.addedOwners.some(x => OWNERS.includes(x.address))); });
test('Tampered plan fails closed', () => { assert.throws(() => verifyPlan({ ...p, threshold: 1 }), /Plan changed/); });
test('Unknown wallet cannot prepare a signing request', async () => { await assert.rejects(next(p.addedOwners[0].address), /Connect one of the two/); });
test('Superseded browser owner cannot prepare a signing request', async () => { await assert.rejects(next('DbGqMhupZZX25mJ3aJPQBoAQpm8DBkyyWXbyDLqhX32D'), /Connect one of the two/); });
test('Backend has no sendTransaction RPC', async () => { const { rpc } = await import('./sandbox.mjs'); await assert.rejects(rpc('sendTransaction'), /broadcasts forbidden/); });
test('Management rejects an unrelated wallet before chain access', async () => { await assert.rejects(management(p.addedOwners[0].address), /two test wallets/); });
for (const [label, change] of [
  ['removal of personal browser owner', p => { p.removedOwners[0].address = OWNERS[0]; }],
  ['duplicate removal', p => { p.removedOwners[1] = p.removedOwners[0]; }],
  ['removal of John instead of Fixture 2', p => { p.removedOwners[0] = p.addedOwners[0]; }],
  ['unexpected final owner', p => { p.finalOwners[0] = p.removedOwners[0].address; }],
]) test(`Rehashed plan still rejects ${label}`, () => {
  const altered = structuredClone(p); delete altered.planSha256; change(altered); altered.planSha256 = sha(JSON.stringify(altered));
  assert.throws(() => verifyPlan(altered));
});
test('Resume helper drives all nine packets through real program without RPC writes', async () => {
  const elf = await readFile(new URL('sources/squads-mainnet.so', OLD));
  assert.equal(sha(elf), p.programElfSha256);
  const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n);
  const b = bytes(reference.rent); svm.setRent(new Rent(b.readBigUInt64LE(0), b.readDoubleLE(8), b[16]));
  svm.addProgramWithLoader(PROGRAM, elf, key('BPFLoaderUpgradeab1e11111111111111111111111'));
  for (const owner of OWNERS) svm.setAccount(key(owner), { lamports: 1_000_000_000, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false });
  const pd = Buffer.concat([Buffer.alloc(45), elf]); pd.writeUInt32LE(3, 0);
  const program = Buffer.concat([Buffer.from([2, 0, 0, 0]), key(reference.programDataAddress).toBuffer()]);
  const wrap = account => account ? { ...account, data: [Buffer.from(account.data).toString('base64'), 'base64'], owner: String(account.owner), lamports: Number(account.lamports), rentEpoch: 0 } : null;
  const readRpc = async (method, params) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: params[0].map(address => {
      if (address === String(PROGRAM)) return wrap({ data: program, owner: key('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true, lamports: 1 });
      if (address === reference.programDataAddress) return wrap({ data: pd, owner: key('BPFLoaderUpgradeab1e11111111111111111111111'), executable: false, lamports: 1 });
      return wrap(svm.getAccount(key(address)));
    }) };
    if (method === 'getMinimumBalanceForRentExemption') return Number(svm.minimumBalanceForRentExemption(BigInt(params[0])));
    if (method === 'getLatestBlockhash') return { value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 10000 } };
    if (method === 'getFeeForMessage') return { value: 5000 };
    if (method === 'simulateTransaction') {
      const result = svm.simulateTransaction(Transaction.from(Buffer.from(params[0], 'base64')));
      if (result instanceof FailedTransactionMetadata) return { value: { err: String(result.err()), logs: result.meta().logs() } };
      return { value: { err: null, logs: result.meta().logs(), unitsConsumed: Number(result.meta().computeUnitsConsumed()) } };
    }
    throw Error(`Unexpected RPC ${method}`);
  };
  const ledgerPreview = await next(OWNERS[1], readRpc);
  assert.equal(ledgerPreview.requiredOwner, OWNERS[0]);
  assert.equal(ledgerPreview.transaction, null, 'Committee Ledger must not be offered the creation transaction');
  let owner = OWNERS[0], successful = 0, done = false;
  for (let attempt = 0; attempt < 18; attempt++) {
    const view = await next(owner, readRpc);
    if (svm.getAccount(key(p.multisig))) {
      const snapshot = await management(owner, readRpc);
      assert.equal(snapshot.threshold, 2);
      assert.equal(snapshot.owners.length, view.owners.length);
      if (view.transaction) assert.equal(snapshot.proposals.find(row => row.phase === view.phase).availableAction, view.actionType);
      if (view.state === 'complete') assert(snapshot.complete);
    }
    if (view.state === 'complete') { assert.equal(view.owners.length, 8); assert.deepEqual(view.owners, finalRoster(p).sort()); done = true; break; }
    if (!view.transaction) { assert(view.requiredOwner && view.requiredOwner !== owner); owner = view.requiredOwner; continue; }
    assert.equal(view.preflight.error, null);
    assert.equal(view.threshold, 2);
    const transaction = Transaction.from(Buffer.from(view.transaction, 'base64'));
    assert.equal(sha(transaction.serializeMessage()), view.messageSha256);
    const result = svm.sendTransaction(transaction);
    assert(!(result instanceof FailedTransactionMetadata), view.title);
    successful++;
  }
  assert(done); assert.equal(successful, 9);
  assert(!svm.getAccount(key('CEbm1TXTFEQLB4T8Senfi6mDPfLqiF4hZvZP9Ehg82Qg')));
});
