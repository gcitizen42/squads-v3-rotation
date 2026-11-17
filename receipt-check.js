'use strict';
// Native wallets may adjust priority fees, but never the reviewed Squads actions.
function verifyWalletReceipt(expected, actual, meta, web3) {
  const fail = message => { throw Error(`STOP: ${message}. Inspect the receipt; do not continue.`); };
  if (meta?.err || !Number.isSafeInteger(meta?.fee) || meta.fee < 0 || meta.fee > 1000000) fail('Receipt failed or network fee exceeded 0.001 SOL');
  if (!actual.verifySignatures() || String(actual.feePayer) !== String(expected.feePayer) || actual.recentBlockhash !== expected.recentBlockhash) fail('Wallet signature, payer or blockhash differs');
  const encode = ix => JSON.stringify({ program: String(ix.programId), keys: ix.keys.map(k => [String(k.pubkey), k.isSigner, k.isWritable]), data: Array.from(ix.data) });
  const isBudget = ix => ix.programId.equals(web3.ComputeBudgetProgram.programId);
  const intended = expected.instructions.filter(ix => !isBudget(ix)).map(encode);
  const observed = actual.instructions.filter(ix => !isBudget(ix)).map(encode);
  if (JSON.stringify(intended) !== JSON.stringify(observed)) fail('Confirmed actions differ from the reviewed transaction');
  const seen = new Set();
  for (const ix of actual.instructions.filter(isBudget)) {
    if (ix.keys.length) fail('Unexpected compute budget accounts');
    const kind = web3.ComputeBudgetInstruction.decodeInstructionType(ix);
    if (seen.has(kind)) fail('Duplicate compute budget instruction');
    seen.add(kind);
    if (kind === 'SetComputeUnitLimit') {
      const { units } = web3.ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix);
      if (units < 1 || units > 1400000) fail('Unexpected compute unit limit');
    } else if (kind === 'SetComputeUnitPrice') {
      const { microLamports } = web3.ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix);
      if (BigInt(microLamports) < 0n || BigInt(microLamports) * 1400000n > 1000000000000n) fail('Priority fee exceeded reviewed bound');
    } else fail('Unreviewed compute budget instruction');
  }
  return { actionsVerified: true, walletAdjustedFees: JSON.stringify(expected.instructions.map(encode)) !== JSON.stringify(actual.instructions.map(encode)), networkFeeSol: meta.fee / 1e9 };
}
if (typeof module !== 'undefined') module.exports = { verifyWalletReceipt };
