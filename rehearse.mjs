import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OLD, PROGRAM, OWNERS, key, sdk, packet, staging, executeIx, txPda, load, save, verifyPlan, sha, msDecode, txDecode, roster, equal, finalRoster, LiteSVM, FailedTransactionMetadata, Rent, SystemProgram, bytes } from './sandbox.mjs';

const plan = await load('outputs/plan.json'); verifyPlan(plan);
const reference = await load('inputs/public-mainnet-reference.json');
const elf = await readFile(new URL('sources/squads-mainnet.so', OLD));
assert.equal(sha(elf), plan.programElfSha256);
const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n);
const rentBytes = bytes(reference.rent);
svm.setRent(new Rent(rentBytes.readBigUInt64LE(0), rentBytes.readDoubleLE(8), rentBytes[16]));
svm.addProgramWithLoader(PROGRAM, elf, key('BPFLoaderUpgradeab1e11111111111111111111111'));
for (const address of OWNERS) svm.setAccount(key(address), { lamports: 1_000_000_000, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false });
const runs = [], stages = [], ms = key(plan.multisig), checks = [];
const check = (label, condition) => { assert(condition, label); checks.push({ label, status: 'PASS' }); };
function send(instructions, owner, label, expectedFailure = false) {
  const tx = packet(instructions, owner, svm.latestBlockhash());
  const serializedBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  assert(serializedBytes <= 1232);
  const result = svm.sendTransaction(tx), failed = result instanceof FailedTransactionMetadata, meta = failed ? result.meta() : result;
  const row = { label, expectedFailure, success: !failed, serializedBytes, units: String(meta.computeUnitsConsumed()), logs: meta.logs(), error: failed ? String(result.err()) : null };
  runs.push(row); assert.equal(failed, expectedFailure, `${label}: ${row.error}`);
  if (expectedFailure) assert.match(row.error, /code: 6001/);
}
function state(label) { const s = msDecode(svm.getAccount(ms).data); stages.push({ label, owners: roster(s), threshold: s.threshold, multisigDataBytes: svm.getAccount(ms).data.length }); return s; }
const create = await sdk().buildCreateMultisig(2, key(plan.createKey), OWNERS.map(key), plan.label, 'No DAO assets or authorities. Both initial owners controlled by Demo.');
send([create], OWNERS[0], 'Create isolated test multisig');
check('Starts at exact two intended owners and threshold 2', equal(roster(state('Created: 2 of 2')), OWNERS) && msDecode(svm.getAccount(ms).data).threshold === 2);
let packetCount = 1;
const phasePacketCounts = {};
for (const phase of ['add', 'remove']) {
  const minRent = Number(svm.minimumBalanceForRentExemption(442n));
  const topUp = phase === 'add' ? Math.max(0, minRent - Number(svm.getAccount(ms).lamports)) : 0;
  const batches = await staging(plan, phase, { topUp });
  for (const [i, batch] of batches.entries()) send(batch, OWNERS[0], `${phase}: upload, activate and first approval packet ${i + 1}/${batches.length}`);
  packetCount += batches.length;
  const transaction = txPda(plan, phase === 'add' ? 1 : 2);
  check(`${phase}: staging leaves roster and threshold unchanged`, equal(roster(msDecode(svm.getAccount(ms).data)), phase === 'add' ? OWNERS : [...OWNERS, ...plan.addedOwners.map(x => x.address)]) && msDecode(svm.getAccount(ms).data).threshold === 2);
  check(`${phase}: exactly one approval after proposal`, txDecode(svm.getAccount(transaction).data).approved.length === 1);
  send([await executeIx(plan, phase, OWNERS[0])], OWNERS[0], `${phase}: one signature cannot execute`, true);
  send([await sdk(OWNERS[1]).buildApproveTransaction(ms, transaction)], OWNERS[1], `${phase}: second owner approves`);
  send([await executeIx(plan, phase, OWNERS[1])], OWNERS[1], `${phase}: second owner executes`);
  packetCount += 2;
  phasePacketCounts[phase] = { upload: batches.length, approve: 1, execute: 1, successful: batches.length + 2 };
  const s = state(phase === 'add' ? 'Added: 2 of 10' : 'Removed Fixture 2 and Fixture 3: 2 of 8');
  check(`${phase}: exact resulting owners; threshold stays 2`, equal(roster(s), phase === 'add' ? [...OWNERS, ...plan.addedOwners.map(x => x.address)] : finalRoster(plan)) && s.threshold === 2);
  check(`${phase}: proposal marked executed`, 'executed' in txDecode(svm.getAccount(transaction).data).status);
}
check('Both initial browser and Ledger owners remain in final eight', OWNERS.every(address => roster(msDecode(svm.getAccount(ms).data)).includes(address)));
check('Only Fixture 2 and Fixture 3 are absent from the final roster', plan.removedOwners.every(row => !roster(msDecode(svm.getAccount(ms).data)).includes(row.address)));
check('Real Council multisig never loaded or touched', !svm.getAccount(key('CEbm1TXTFEQLB4T8Senfi6mDPfLqiF4hZvZP9Ehg82Qg')));
check('Real Council asset vault never loaded or touched', !svm.getAccount(key('GrAj8xNx6rHwRT38eCATRZWnozWZQwRaQQuasF1f7BL8')));
const created = [ms, ...[1, 2].map(index => txPda(plan, index))];
const payerBalanceAfter = OWNERS.reduce((sum, address) => sum + Number(svm.getAccount(key(address)).lamports), 0);
const result = { status: 'PASSED', planSha256: plan.planSha256, programElfSha256: sha(elf), scope: 'Fresh synthetic local LiteSVM with actual deployed Squads v3 bytes; recreates the sandbox from scratch, not its live on-chain state or a chain fork', signatureVerificationDisabledInVM: true, realSignaturesCollected: false, submitted: false, generatedAt: new Date().toISOString(), stages, checks, runs, phasePacketCounts, successfulLivePacketCount: packetCount, successfulSyntheticPacketCount: packetCount, remainingPacketsAfterUserCreation: packetCount - 1, localTotalPayerDebitSol: (2_000_000_000 - payerBalanceAfter) / 1e9, payerDebitSol: OWNERS.map(address => ({ address, sol: (1_000_000_000 - Number(svm.getAccount(key(address)).lamports)) / 1e9 })), trackedProposalAccounts: created.map(String), limitations: ['Synthetic fee balances and disabled signature verification; real wallet/Ledger proposal approval untested.', 'Synthetic fixture only; never fund these addresses.', 'Two of ANY ten owners can authorize the expanded test multisig; two of ANY eight can authorize the final roster.', 'Local fee/rent debit is indicative, not a guaranteed live quote.'] };
assert(result.localTotalPayerDebitSol < 0.1, 'Unexpected funding requirement');
await save('outputs/rehearsal.json', result);
console.log(JSON.stringify({ status: result.status, checks: checks.length, stages: stages.map(s => ({ label: s.label, threshold: s.threshold, owners: s.owners.length })), successfulPackets: packetCount, localDebitSol: result.localTotalPayerDebitSol, submitted: false }, null, 2));
