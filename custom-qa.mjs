import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { load, save, OLD, key, sdk, packet, sha } from './sandbox.mjs';
import { buildActions, desiredBatches, desiredExecute, proposalAddress } from './desired.mjs';
const require = createRequire(new URL('package.json', OLD)), { Keypair, Transaction } = require('@solana/web3.js'), bs58 = require('bs58');
const { chromium } = require('playwright');
const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:8774';
const real = await load('outputs/plan.json'), rehearsal = await load('outputs/rehearsal.json');
const keys = [Keypair.generate(), Keypair.generate()], owners = keys.map(row => String(row.publicKey));
const plan = { ...real, owners, planSha256: 'synthetic-desired-ui' };
const extra = '6FCvzYdEjYg8jHZGr6GYtcAnmY2GJ7xuko8W7YrtyuJV', members = [...owners, ...real.addedOwners.map(row => row.address)], previous = [...members, extra];
const built = await buildActions({ keys: previous.map(key), threshold: 2 }, members, 2, 'CEbm1TXTFEQLB4T8Senfi6mDPfLqiF4hZvZP9Ehg82Qg');
const custom = 'CEbm1TXTFEQLB4T8Senfi6mDPfLqiF4hZvZP9Ehg82Qg';
const outsider = Keypair.generate();
let loaded = real.multisig;
const spec = { multisig: custom, members, threshold: 2, previousOwners: previous, previousThreshold: 2, proposer: owners[0], index: 3, topUp: 0, ...built };
const id = sha(JSON.stringify(spec)), record = { id, spec, rehearsal: { status: 'PASSED', uploadPackets: 1 }, createdAt: '2026-11-16T00:00:00Z' };
const blockhash = '11111111111111111111111111111111';
const txs = [
  packet((await desiredBatches(spec))[0], owners[0], blockhash),
  packet([await sdk(owners[1]).buildApproveTransaction(key(custom), proposalAddress(3, custom))], owners[1], blockhash),
  packet([await desiredExecute(spec, owners[1])], owners[1], blockhash)
];
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) }), results = [];
try {
  for (const width of [1280, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(20000);
    let sent = 0, reviewed = false, raw, received;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const snapshot = owner => ({
      planSha256: plan.planSha256, slot: 12345, multisig: loaded, vault: plan.vault, vaultSol: 0, threshold: 2,
      owners: (sent === 3 ? members : previous).map(address => ({ address, name: 'Synthetic member' })), connected: owner, latestIndex: sent ? 3 : 2, historyFrom: 1,
      proposals: [
        ...(reviewed ? [{ index: 3, address: String(proposalAddress(3, custom)), status: sent === 0 ? 'Prepared locally / not submitted' : sent === 1 ? 'active' : sent === 2 ? 'executeReady' : 'executed', local: sent === 0, approvals: sent ? sent === 1 ? [owners[0]] : owners : [], threshold: 2, actions: built.summary, instructionCount: 1, attachedInstructions: sent ? 1 : 0, planId: id, yourVote: !owner ? 'Not connected' : sent && (sent > 1 || owner === owners[0]) ? 'Approved' : 'Not voted', availableAction: owner === owners[0] && sent === 0 ? 'upload' : owner === owners[1] && sent === 1 ? 'approve' : owner === owners[1] && sent === 2 ? 'execute' : null }] : []),
        { index: 2, address: String(proposalAddress(2, loaded)), status: 'executed', local: false, approvals: owners, threshold: null, actions: [{ kind: 'addMember', address: extra }], instructionCount: 1, attachedInstructions: 1, planId: null, yourVote: 'Approved', availableAction: null }
      ]
    });
    await page.route('**/api/plan', route => route.fulfill({ json: { uiVersion: 'custom-rotation-7', plan, rehearsal: { ...rehearsal, planSha256: plan.planSha256 } } }));
    await page.route('**/api/management**', route => { const url = new URL(route.request().url()); loaded = url.searchParams.get('multisig') || real.multisig; return route.fulfill({ json: snapshot(url.searchParams.get('owner')) }); });
    await page.route('**/api/desired/prepare', route => {
      received = route.request().postDataJSON(); assert.equal(received.multisig, custom); assert.deepEqual(received.members, members); assert.equal(received.threshold, 2); assert.equal(received.proposer, owners[0]);
      reviewed = true; return route.fulfill({ json: record });
    });
    await page.route('**/api/desired/next?**', route => {
      const url = new URL(route.request().url()), owner = url.searchParams.get('owner');
      assert.equal(url.searchParams.get('id'), id); assert.equal(owner, sent === 0 ? owners[0] : owners[1]); assert(sent < 3);
      const tx = txs[sent];
      return route.fulfill({ json: { plan, review: record, desiredPlanId: id, phase: 'desired', actionType: sent === 0 ? 'upload' : sent === 1 ? 'approve' : 'execute', state: 'active', title: 'Reviewed desired membership changes', owners: previous, threshold: 2, approvalThreshold: 2, requiredOwner: owner, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), messageSha256: sha(tx.serializeMessage()), feeSol: .000005, preflight: { error: null } } });
    });
    await page.route('https://solana-rpc.publicnode.com/**', route => {
      const { method } = route.request().postDataJSON(); let result;
      if (method === 'getGenesisHash') result = plan.chain;
      else if (method === 'isBlockhashValid') result = { value: true };
      else if (method === 'simulateTransaction') result = { value: { err: null } };
      else if (method === 'getSignatureStatuses') result = { value: [{ err: null, confirmationStatus: 'confirmed' }] };
      else if (method === 'getTransaction') result = { transaction: [raw, 'base64'], meta: { err: null, fee: 5000 } };
      else throw Error('No app broadcasts: ' + method);
      return route.fulfill({ json: { jsonrpc: '2.0', id: 1, result } });
    });
    await page.exposeFunction('mockSend', value => {
      const tx = Transaction.from(Buffer.from(value, 'base64')); assert(tx.verifySignatures()); assert.equal(sha(tx.serializeMessage()), sha(txs[sent].serializeMessage()));
      sent++; raw = value; return { signature: bs58.encode(tx.signature) };
    });
    await page.addInitScript(({ addresses, secrets }) => {
      window.qa = { index: 0, calls: 0, activations: [], events: {} };
      const provider = { get publicKey() { return addresses[window.qa.index]; }, connect: async () => {}, disconnect: async () => {},
        on(name, callback) { window.qa.events[name] = callback; },
        signAndSendTransaction(tx) {
          window.qa.calls++; window.qa.activations.push(navigator.userActivation.isActive);
          tx.partialSign(solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(secrets[window.qa.index])));
          return window.mockSend(btoa(String.fromCharCode(...tx.serialize())));
        }
      };
      window.phantom = { solana: provider };
    }, { addresses: [...owners, String(outsider.publicKey)], secrets: [...keys, outsider].map(row => Array.from(row.secretKey)) });
    await page.goto(BASE + '/?v=custom-rotation-7#management');
    await page.waitForFunction(() => !document.getElementById('load-multisig').disabled);
    await page.locator('#multisig-address').fill(custom);
    await page.locator('#load-multisig').click();
    await page.waitForFunction(() => !document.getElementById('load-multisig').disabled);
    await page.evaluate(() => { window.qa.index = 2; });
    await page.locator('#connect').click();
    await page.locator('#membership').filter({ hasText: 'NOT a current member' }).waitFor();
    assert(await page.locator('#desired-review').isDisabled());
    await page.evaluate(() => { window.qa.index = 0; window.qa.events.accountChanged?.(); });
    await page.locator('#management-refresh').click();
    await page.waitForFunction(() => !document.getElementById('desired-review').disabled);
    assert.equal(await page.evaluate(() => window.qa.calls), 0);
    await page.locator('#desired-members').fill(members.join('\n'));
    await page.locator('#desired-review').click();
    await page.locator('#desired-summary').filter({ hasText: '2 of 10' }).waitFor();
    assert.equal(sent, 0); assert(await page.locator('#submit').isDisabled());
    assert((await page.locator('#desired-changes').textContent()).includes(extra));
    await page.locator('#desired-prepare').click();
    await page.locator('#flow').filter({ hasText: 'Prepared and simulated' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('ack').disabled);
    await page.locator('#desired-threshold').fill('1');
    assert(await page.locator('#submit').isDisabled()); assert(await page.locator('#desired-review-panel').isHidden());
    await page.locator('#desired-threshold').fill('2');
    await page.locator('#desired-review').click();
    await page.locator('#desired-summary').filter({ hasText: '2 of 10' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('desired-prepare').disabled);
    await page.screenshot({ path: new URL('outputs/custom-ui-' + width + '.png', import.meta.url).pathname, fullPage: true });
    await page.locator('#desired-prepare').click();
    await page.locator('#flow').filter({ hasText: 'Prepared and simulated' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('ack').disabled);
    await page.locator('#ack').check(); await page.locator('#submit').click();
    await page.locator('#management-proposals').filter({ hasText: 'active' }).waitFor();
    assert.equal(sent, 1);
    await page.evaluate(() => { window.qa.index = 1; window.qa.events.accountChanged?.(); });
    await page.locator('#management-refresh').click();
    await page.locator('[data-management-action=approve]').click();
    await page.locator('#flow').filter({ hasText: 'Prepared and simulated' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('ack').disabled);
    await page.locator('#ack').check(); await page.locator('#submit').click();
    await page.locator('[data-management-action=execute]').click();
    await page.locator('#flow').filter({ hasText: 'Prepared and simulated' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('ack').disabled);
    await page.locator('#ack').check(); await page.locator('#submit').click();
    await page.locator('#management-summary').filter({ hasText: '2 of 10' }).waitFor();
    assert.equal(sent, 3); assert((await page.evaluate(() => window.qa.activations)).every(Boolean)); assert.deepEqual(errors, []);
    const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert(bounds.scroll <= bounds.width);
    results.push({ width, status: 'PASS', customTargetVerified: true, nonmemberBlocked: true, previewBeforeSigning: true, localAndOnchainHistory: true, editingInvalidatesSigningRequest: true, explicitUploadApprovalExecution: true, nativeEphemeralSignatures: true, bounds, realSubmissions: 0 });
    await page.close();
  }
} finally { await browser.close(); }
const base = BASE;
assert.equal((await fetch(base + '/api/desired/prepare', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
assert.equal((await fetch(base + '/api/desired/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
assert.equal((await fetch(base + '/api/desired/prepare', { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 400);
await save('outputs/custom-ui-qa.json', { status: 'PASSED', results, localPreparationOriginGuards: 'PASS', scope: 'Mocked RPC and ephemeral synthetic wallets only. No real user keys or network writes.' });
console.log(JSON.stringify(results, null, 2));
