'use strict';
const $ = id => document.getElementById(id);
const RPC = 'https://solana-rpc.publicnode.com';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const UI_VERSION = 'custom-rotation-7';
let bundle, provider, prepared, approvalRequest, readyTimer, busy = false;
let activeTab = 'management';
let managementSnapshot = null;
let desiredReview = null;
let selectedMultisig = null;
const connectedMember = () => Boolean(provider?.publicKey && $('multisig-address').value.trim() === selectedMultisig && managementSnapshot?.multisig === selectedMultisig && managementSnapshot.owners.some(row => row.address === String(provider.publicKey)));
let flowStage = 'Idle';
const phaseOptions = () => bundle?.plan.ui?.phases || { add: { phase: 'add', label: 'Add Owners' }, remove: { phase: 'remove', label: 'Remove Fixture 2 + Fixture 3' } };
const storageKey = hash => `${bundle.plan.ui?.storagePrefix || 'sandbox'}-${hash}`;
const fromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const toBase64 = value => btoa(String.fromCharCode(...value));
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value))).map(x => x.toString(16).padStart(2, '0')).join('');
function stage(label) { flowStage = label; $('flow').textContent = label; }
async function api(path) {
  const r = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(60000) }); const body = await r.json();
  if (!r.ok || body.error) throw Error(`Local ${path.split('?')[0]}, HTTP ${r.status}: ${body.error || 'Request failed'}`);
  return body;
}
async function prepareApi(input) {
  const response = await fetch('/api/desired/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) });
  const result = await response.json(); if (!response.ok || result.error) throw Error(result.error || 'Proposal preparation failed'); return result;
}
async function rpc(method, params = []) {
  if (!['getGenesisHash', 'getSignatureStatuses', 'getTransaction', 'simulateTransaction', 'isBlockhashValid'].includes(method)) throw Error('Unexpected browser RPC method');
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const body = await r.json();
  if (!r.ok || body.error) throw Error(`Browser RPC ${new URL(RPC).hostname}, HTTP ${r.status}: ${JSON.stringify(body.error || body)}. No automatic retry was made.`);
  return body.result;
}
function pairs(element, rows) {
  element.replaceChildren();
  for (const [label, value] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; element.append(dt, dd); }
}
function journal() {
  $('journal').replaceChildren();
  for (const key of [bundle.plan.previousPlanSha256, bundle.plan.planSha256].filter(Boolean)) {
    let rows; try { rows = JSON.parse(localStorage.getItem(storageKey(key)) || '[]'); } catch { rows = []; }
    for (const row of rows) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(row.signature)) continue;
      const li = document.createElement('li'), a = document.createElement('a'); a.href = `https://explorer.solana.com/tx/${row.signature}`; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = `${row.title}: ${row.signature}`; li.append(a); $('journal').append(li);
    }
  }
}
function reset() { clearTimeout(readyTimer); approvalRequest = null; $('ack').checked = false; enable(); }
function enable() {
  const connected = connectedMember();
  const phase = prepared?.phase;
  const complete = prepared?.state === 'complete';
  $('connect').disabled = busy || !bundle; $('connect').hidden = Boolean(provider?.publicKey);
  $('disconnect').disabled = busy; $('disconnect').hidden = !provider;
  for (const id of ['tab-rotation', 'tab-management', 'management-refresh', 'load-multisig', 'multisig-address']) $(id).disabled = busy || !bundle;
  for (const button of document.querySelectorAll('[data-management-action]')) button.disabled = busy || !connected || managementSnapshot?.connected !== String(provider?.publicKey);
  for (const id of ['desired-current', 'desired-council']) $(id).disabled = busy || !managementSnapshot;
  for (const id of ['desired-members', 'desired-threshold', 'external-quorum']) $(id).disabled = busy;
  $('desired-review').disabled = busy || !connected || !managementSnapshot;
  $('desired-prepare').disabled = busy || !connected || !desiredReview || desiredReview.spec.proposer !== String(provider?.publicKey);
  for (const name of ['add', 'remove']) {
    const option = phaseOptions()[name];
    $(name).hidden = !option;
    if (!option) continue;
    $(name).disabled = true;
    const subject = option.label;
    const step = phase === option.phase ? prepared.actionType : null;
    $(name).textContent = step === 'approve' ? `Prepare Approval: ${subject}` : step === 'execute' ? `Prepare Execution: ${subject}` : `Prepare ${subject}`;
  }
  $('ack').disabled = busy || !approvalRequest;
  $('submit').disabled = busy || !approvalRequest || Date.now() > approvalRequest.expiresAt || !connected || String(provider.publicKey) !== approvalRequest.owner || !$('ack').checked;
  $('approval-gate').textContent = busy ? flowStage : !connected ? ('A connected current member is required for signing.') : complete ? prepared.title : !approvalRequest ? 'Prepare the next action with the required wallet.' : !$('ack').checked ? 'Review the action, then tick the acknowledgement.' : 'Ready for wallet approval.';
}
function walletAvailability() {
  $('wallet-availability').textContent = window.phantom?.solana ? 'Phantom detected' : window.solflare ? 'Solflare detected' : 'Open this page in Brave with your Phantom extension.';
}
async function currentPlan() {
  const data = await api('/api/plan');
  if (data.uiVersion !== UI_VERSION || data.plan.planSha256 !== bundle.plan.planSha256) throw Error('The plan or helper changed. Reload before signing.');
}
async function refresh(wantedPhase, wantedAction) {
  reset(); prepared = null; stage('Checking live state and preparing the next action');
  const owner = String(provider?.publicKey);
  if (!bundle.plan.owners.includes(owner)) throw Error(bundle.plan.ui?.connectHint || 'Connect your browser wallet or committee Ledger.');
  $('step').textContent = 'Checking the program, owner set, threshold and exact proposal...';
  const view = await api(`/api/next?owner=${encodeURIComponent(owner)}`);
  await acceptView(view, owner, wantedPhase, wantedAction);
}
async function prepareDynamic(id, wantedAction) {
  reset(); prepared = null; stage('Checking the reviewed proposal and live configuration');
  const owner = String(provider?.publicKey);
  if (!connectedMember()) throw Error('Connected wallet is not a current member of this multisig.');
  const view = await api('/api/desired/next?id=' + encodeURIComponent(id) + '&owner=' + encodeURIComponent(owner));
  if (view.review?.spec.multisig && view.review.spec.multisig !== selectedMultisig) throw Error('Proposal targets a different multisig');
  if (view.review) showDesiredReview(view.review);
  await acceptView(view, owner, 'desired', wantedAction);
  $('step').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function acceptView(view, owner, wantedPhase, wantedAction) {
  if (view.plan.planSha256 !== bundle.plan.planSha256) throw Error('Plan changed. Reload before preparing.');
  prepared = view;
  $('step').textContent = view.title;
  pairs($('state'), [['Live owners / threshold', `${view.owners.length} owners / ${view.threshold} required`], ['Approvals', `${view.approvals?.length || 0} / ${view.approvalThreshold || bundle.plan.approvalThreshold || 2}`], ['Required wallet', view.requiredOwnerLabel || view.requiredOwner || 'None'], ['Estimated network fee', view.feeSol === undefined ? 'Not prepared' : `${view.feeSol} SOL, plus any stated account rent`]]);
  $('preview').textContent = JSON.stringify({ ...view, plan: undefined }, null, 2);
  if (wantedPhase && wantedPhase !== view.phase && view.state !== 'complete') throw Error('Live state moved to the next stage. Review the displayed action and prepare it again.');
  if (wantedAction && wantedAction !== view.actionType) throw Error('Proposal status changed. Refresh management and review the available action again.');
  if (!view.transaction) { stage(view.title); return; }
  await currentPlan();
  if (await rpc('getGenesisHash') !== GENESIS) throw Error('Not Solana mainnet');
  const tx = solanaWeb3.Transaction.from(fromBase64(view.transaction));
  if (String(tx.feePayer) !== owner || await hash(tx.serializeMessage()) !== view.messageSha256) throw Error('Prepared transaction differs from the reviewed request');
  const preflight = await rpc('simulateTransaction', [view.transaction, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  if (preflight.value.err) throw Error(`Preflight failed: ${JSON.stringify(preflight.value.err)}. Nothing sent.`);
  const valid = await rpc('isBlockhashValid', [tx.recentBlockhash, { commitment: 'confirmed' }]);
  if (valid.value !== true) throw Error('Blockhash expired. Prepare again; no wallet request sent.');
  await currentPlan();
  if (String(provider?.publicKey) !== owner) throw Error('Wallet account changed. Reconnect and prepare again.');
  approvalRequest = { tx, owner, title: view.title, unsignedBase64: view.transaction, messageBase64: toBase64(tx.serializeMessage()), messageSha256: view.messageSha256, planSha256: bundle.plan.planSha256, expiresAt: Date.now() + 45000 };
  readyTimer = setTimeout(() => { approvalRequest = null; if (!busy) { stage('Preparation expired. Prepare this action again.'); enable(); } }, 45000);
  stage('Prepared and simulated. Waiting for your review.');
}
async function refreshManagement() {
  if ($('multisig-address').value.trim() !== selectedMultisig) throw Error('Load the entered multisig first.');
  stage('Reading test multisig owners, proposals and votes');
  const owner = String(provider?.publicKey);
  const query = '?multisig=' + encodeURIComponent(selectedMultisig) + (provider?.publicKey ? '&owner=' + encodeURIComponent(owner) : '');
  const target = selectedMultisig;
  const view = await api('/api/management' + query);
  if (view.multisig !== target || selectedMultisig !== target) throw Error('Multisig changed during refresh');
  if (view.planSha256 !== bundle.plan.planSha256) throw Error('Plan changed. Reload before proceeding.');
  if (view.connected && view.connected !== String(provider?.publicKey)) throw Error('Account changed during refresh. Refresh again.');
  managementSnapshot = view;
  $('safe-address').textContent = view.multisig;
  $('membership').textContent = !provider?.publicKey ? 'Read-only / connect a current member' : connectedMember() ? 'Current membership verified on chain' : 'NOT a current member. Signing blocked until your addition executes.';
  $('banner').textContent = view.multisig === bundle.plan.multisig ? 'SOLANA MAINNET / TEST MULTISIG' : 'SOLANA MAINNET / CUSTOM MULTISIG';
  $('management-status').textContent = 'Live slot ' + view.slot + ' / Squads v3';
  $('progress').textContent = 'Configure / Review / Submit';
  if (!$('desired-members').value.trim()) useCurrentMembers();
  $('history-scope').textContent = 'On-chain history: latest 50 proposals at most, through #' + view.latestIndex + '. Local drafts are labelled separately.';
  pairs($('management-summary'), [['Multisig', view.multisig], ['Threshold', view.threshold + ' of ' + view.owners.length], ['Vault SOL', view.vaultSol], ['Connected wallet', view.connected || 'Read-only / not connected']]);
  $('management-owners').replaceChildren();
  for (const row of view.owners) { const li = document.createElement('li'); li.textContent = row.name + ': ' + row.address + (row.connected ? ' (connected)' : ''); $('management-owners').append(li); }
  $('management-proposals').replaceChildren();
  for (const row of view.proposals) {
    const article = document.createElement('article'); article.className = 'proposal-row';
    const h = document.createElement('h3'); h.textContent = '#' + row.index + ' / ' + (row.local ? 'Local ownership draft' : 'On-chain proposal'); article.append(h);
    const info = document.createElement('p'); info.textContent = row.status + (row.stale ? ' (stale)' : '') + ' | approvals ' + row.approvals.length + '/' + (row.threshold || 'historical quorum unknown') + ' | your vote: ' + row.yourVote; article.append(info);
    if (row.creator) { const author = document.createElement('p'); author.textContent = (row.local ? 'Prepared by: ' : 'Proposed by: ') + row.creator + (row.local && row.createdAt ? ' / ' + new Date(row.createdAt).toLocaleString() : ''); article.append(author); }
    const count = document.createElement('p'); count.textContent = row.attachedInstructions + '/' + row.instructionCount + ' instructions uploaded'; article.append(count);
    const link = document.createElement('a'); link.href = 'https://explorer.solana.com/address/' + row.address; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = row.address; article.append(link);
    const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ol'); summary.textContent = 'Exact owner changes and approvals'; details.append(summary);
    for (const action of row.actions) { const li = document.createElement('li'); li.textContent = action.kind + ': ' + (action.threshold !== undefined ? action.threshold : action.address || 'See raw chain data'); list.append(li); }
    details.append(list);
    const votes = document.createElement('p'); votes.textContent = row.approvals.length ? 'Approved by: ' + row.approvals.join(', ') : 'No approvals yet'; details.append(votes); article.append(details);
    if (row.availableAction) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.managementAction = row.availableAction;
      button.textContent = row.availableAction === 'approve' ? 'Prepare My Approval' : row.availableAction === 'execute' ? 'Prepare Execution' : row.status === 'not proposed' ? 'Prepare Proposal' : 'Continue Proposal Upload';
      button.onclick = () => run(() => prepareDynamic(row.planId, row.availableAction)); article.append(button);
    } else {
      const waiting = document.createElement('p');
      waiting.textContent = row.status === 'executed' ? 'Executed' : !row.planId ? 'External proposal / read-only' : row.stale ? 'Stale / rebuild from live state' : row.yourVote === 'Approved' ? 'Your approval is recorded' : 'No eligible action for this wallet';
      article.append(waiting);
    }
    $('management-proposals').append(article);
  }
  stage('Multisig state loaded. No signing request.');
}
function invalidateDesired() {
  reset(); desiredReview = null; $('desired-review-panel').hidden = true;
  $('external-quorum-row').hidden = selectedMultisig !== bundle?.plan.multisig || Number($('desired-threshold').value) <= 2;
  enable();
}
function useCurrentMembers() {
  if (!managementSnapshot) return;
  $('desired-members').value = managementSnapshot.owners.map(row => row.address).join('\n');
  $('desired-threshold').value = managementSnapshot.threshold; invalidateDesired();
}
$('desired-current').onclick = useCurrentMembers;
$('desired-council').onclick = () => {
  $('desired-members').value = [...new Set([...bundle.plan.owners, ...bundle.plan.addedOwners.map(row => row.address)])].join('\n'); invalidateDesired();
};
for (const id of ['desired-members', 'desired-threshold', 'external-quorum']) $(id).addEventListener('input', invalidateDesired);
$('desired-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    invalidateDesired(); stage('Building changes and rehearsing against the deployed program locally');
    const text = $('desired-members').value.trim();
    const members = text.startsWith('[') ? JSON.parse(text).map(row => typeof row === 'string' ? row : row.address) : text.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    const record = await prepareApi({ multisig: selectedMultisig, members, threshold: Number($('desired-threshold').value), proposer: String(provider?.publicKey), ackExternalQuorum: $('external-quorum').checked });
    showDesiredReview(record);
    stage('Local plan reviewed and rehearsed. Nothing signed or submitted.');
    await refreshManagement();
  });
};
function showDesiredReview(record) {
    desiredReview = record; $('desired-review-panel').hidden = false;
    pairs($('desired-summary'), [['Multisig', record.spec.multisig || selectedMultisig], ['Current configuration', record.spec.previousThreshold + ' of ' + record.spec.previousOwners.length], ['Desired configuration', record.spec.threshold + ' of ' + record.spec.members.length], ['Approvals required NOW', record.spec.previousThreshold], ['Proposal index', record.spec.index], ['Wallet upload packets', record.rehearsal.uploadPackets], ['Local rehearsal', record.rehearsal.status + ' / synthetic signatures only'], ['Configuration rent top-up', record.spec.topUp / 1e9 + ' SOL'], ['Plan SHA-256', record.id]]);
    $('desired-changes').replaceChildren();
    for (const change of record.spec.summary) { const li = document.createElement('li'); li.textContent = change.kind + ': ' + (change.address || change.threshold); $('desired-changes').append(li); }
    $('desired-final-members').replaceChildren();
    for (const address of record.spec.members) { const li = document.createElement('li'); li.textContent = address; $('desired-final-members').append(li); }
    $('desired-warning').textContent = record.spec.threshold > 2 ? 'Future proposals need other members to sign. The existing quorum still authorizes this proposal.' : record.spec.threshold < record.spec.previousThreshold ? 'This lowers the approval threshold. All changes apply only on execution.' : 'All changes apply together on execution, not on proposal upload.';
    $('desired-download').href = '/api/desired/plan?id=' + record.id;
}
$('desired-prepare').onclick = () => run(() => prepareDynamic(desiredReview.id, 'upload'));
async function changeTab(name) {
  if (busy) return;
  activeTab = name; reset(); prepared = null;
  for (const tab of ['rotation', 'management']) {
    $('tab-' + tab).setAttribute('aria-selected', String(tab === name));
    $('tab-' + tab).tabIndex = tab === name ? 0 : -1;
    $(tab + '-panel').hidden = tab !== name;
  }
  history.replaceState(null, '', name === 'management' ? '#management' : '#rotation');
  await run(async () => {
    if (name === 'management') { $('step').textContent = 'Select a proposal action, then review before sending.'; await refreshManagement(); }
    else { $('step').textContent = 'Original fixed plan archived. Use Multisig Management for new changes.'; stage('Read-only original plan'); }
  });
}
$('tab-rotation').onclick = () => changeTab('rotation');
$('tab-management').onclick = () => changeTab('management');
for (const id of ['tab-rotation', 'tab-management']) $(id).onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
  event.preventDefault(); const name = event.key === 'Home' ? 'rotation' : event.key === 'End' ? 'management' : activeTab === 'rotation' ? 'management' : 'rotation';
  $('tab-' + name).focus(); changeTab(name);
};

$('multisig-address').oninput = () => { reset(); managementSnapshot = null; desiredReview = null; $('desired-review-panel').hidden = true; $('membership').textContent = 'Address changed. Load and verify before signing.'; enable(); };
$('load-multisig').onclick = () => run(async () => {
  reset(); desiredReview = null; prepared = null; managementSnapshot = null; $('desired-review-panel').hidden = true;
  selectedMultisig = String(new solanaWeb3.PublicKey($('multisig-address').value.trim()));
  $('desired-members').value = ''; $('management-proposals').replaceChildren(); $('state').replaceChildren();
  await refreshManagement();
  const url = new URL(location.href); url.searchParams.set('multisig', selectedMultisig); history.replaceState(null, '', url);
});

$('management-refresh').onclick = () => run(async () => { reset(); await refreshManagement(); });
async function run(fn) {
  if (busy) return;
  busy = true; enable();
  try { await fn(); }
  catch (error) { $('result').textContent = `${flowStage}: ${error?.message || JSON.stringify(error)}`; stage('Stopped. Review the result before retrying.'); reset(); }
  finally { busy = false; enable(); }
}
$('connect').onclick = () => run(async () => {
  reset(); prepared = null; stage('Connecting wallet; no transaction approval requested');
  provider = window.phantom?.solana || window.solflare;
  if (!provider) throw Error('Phantom or Solflare is not available in this browser. Use Brave with your wallet extension.');
  await provider.connect();
  $('connected').textContent = String(provider.publicKey);

  provider.on?.('accountChanged', () => { reset(); prepared = null; managementSnapshot = null; $('connected').textContent = String(provider?.publicKey || 'Not connected'); $('step').textContent = 'Account changed. Refresh and prepare again with this wallet.'; enable(); });
  provider.on?.('disconnect', () => { reset(); prepared = null; managementSnapshot = null; $('connected').textContent = 'Not connected'; enable(); });
  $('result').textContent = 'Connected. No transaction signed or sent.';
  if (activeTab === 'management' && selectedMultisig) await refreshManagement(); else stage('Wallet connected. Load a multisig.');
});
$('disconnect').onclick = () => run(async () => { reset(); prepared = null; await provider?.disconnect(); provider = null; $('connected').textContent = 'Not connected'; $('step').textContent = 'Select the next account in your wallet and reconnect.'; });
$('add').onclick = () => run(() => refresh(phaseOptions().add.phase));
$('remove').onclick = () => run(() => refresh(phaseOptions().remove.phase));
$('ack').onchange = enable;
$('submit').onclick = () => run(async () => {
  const request = approvalRequest;
  if (!request || !$('ack').checked) throw Error('Prepare and acknowledge the action first.');
  if (Date.now() > request.expiresAt || request.planSha256 !== bundle.plan.planSha256) throw Error('Preparation expired or plan changed. Prepare again.');
  if (String(provider?.publicKey) !== request.owner) throw Error('Wallet account changed. Prepare again.');
  if (toBase64(request.tx.serializeMessage()) !== request.messageBase64) throw Error('Prepared message changed. Nothing sent.');
  // All asynchronous preparation happens earlier, preserving the trusted approval click.
  if (typeof provider.signAndSendTransaction !== 'function') throw Error('This wallet does not support native approve-and-send. Nothing sent.');
  clearTimeout(readyTimer); approvalRequest = null;
  stage('Waiting for wallet approval and send');
  $('result').textContent = 'Review and approve in Phantom. Ledger may also require device confirmation.';
  const waiting = setTimeout(() => { $('result').textContent = 'Wallet request is still pending. Open Phantom and check pending requests. Do not send again.'; }, 12000);
  let response;
  try { response = await provider.signAndSendTransaction(request.tx, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }); }
  catch (error) { throw Error(`Wallet approve-and-send failed: ${error?.message || JSON.stringify(error)}. No automatic retry. If you approved, check wallet history before trying again.`); }
  finally { clearTimeout(waiting); }
  await confirmReceipt(typeof response === 'string' ? response : response?.signature, request);
});
async function confirmReceipt(signature, request) {
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw Error('No valid receipt returned. Check wallet history; delivery is unknown.');
  let rows; try { rows = JSON.parse(localStorage.getItem(storageKey(bundle.plan.planSha256)) || '[]'); } catch { rows = []; }
  rows.push({ signature, title: request.title, at: new Date().toISOString() });
  try { localStorage.setItem(storageKey(bundle.plan.planSha256), JSON.stringify(rows)); journal(); } catch { /* Confirmation must continue even if browser storage is unavailable. */ }
  reset(); stage('Waiting for on-chain confirmation'); $('result').textContent = `Submitted ${signature}. Do not resend.`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
    if (status?.err) throw Error(`Transaction failed: ${JSON.stringify(status.err)}. Inspect its receipt.`);
    if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) {
      const receipt = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!receipt) { stage('Confirmed; receipt details pending'); $('result').textContent = `Confirmed ${signature}. Inspect the receipt and live state before continuing.`; return; }
      const actual = solanaWeb3.Transaction.from(fromBase64(receipt.transaction[0]));
      const checked = verifyWalletReceipt(solanaWeb3.Transaction.from(fromBase64(request.unsignedBase64)), actual, receipt.meta, solanaWeb3);
      stage('Confirmed; exact actions and signature verified');
      const confirmed = `Confirmed and actions verified: ${signature}. Network fee ${checked.networkFeeSol} SOL.${checked.walletAdjustedFees ? ' Wallet adjusted only bounded compute-budget fees.' : ''}`;
      try { if (activeTab === 'management') await refreshManagement(); else await refresh(); }
      catch (error) { reset(); stage('Confirmed; next action not prepared'); $('step').textContent = error.message; }
      $('result').textContent = confirmed;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw Error(`Confirmation not yet observed: ${signature}. Check the receipt and live state; do not send blindly again.`);
}
api('/api/plan').then(data => {
  if (data.uiVersion !== UI_VERSION || data.rehearsal.status !== 'PASSED' || data.rehearsal.planSha256 !== data.plan.planSha256) throw Error('Build or rehearsal changed. Reload; do not sign.');
  bundle = data; const p = data.plan;
  $('notice').textContent = 'Ownership and threshold changes only. Submission is not execution. Current quorum must approve; no asset transfers.';
  selectedMultisig = new URL(location.href).searchParams.get('multisig') || ''; $('multisig-address').value = selectedMultisig;
  $('boot-status').hidden = true; $('safe-address').textContent = p.multisig;
  if (p.ui) {
    for (const id of ['title', 'banner', 'progress', 'notice', 'ack-label', 'owners-heading']) if (p.ui[id]) $(id).textContent = p.ui[id];
    document.title = p.ui.title;
    $('creation-receipt').hidden = true;
  }
  pairs($('plan'), [['Multisig', p.multisig], ['Vault', p.vault], ['Plan SHA-256', p.planSha256], ['Program', p.program], ['Browser RPC', RPC], ['Build', UI_VERSION], ['Receipt fee bound', '0.001 SOL; review actual fee in your wallet before sending']]);
  for (const [i, address] of p.owners.entries()) { const li = document.createElement('li'); li.textContent = `${p.ui ? 'Current owner' : i ? 'Committee Ledger' : 'Browser proposer'}: ${address}`; $('owners').append(li); }
  $('additions-heading').textContent = `${p.addedOwners.length} Additions`;
  $('removals-heading').textContent = `${p.removedOwners.length} Removals`;
  for (const [id, owners] of [['committee', p.addedOwners], ['removals', p.removedOwners]]) for (const owner of owners) { const li = document.createElement('li'); li.textContent = `${owner.name}: ${owner.address}`; $(id).append(li); }
  $('checks').textContent = p.ui?.evidence || `${data.rehearsal.status}: ${data.rehearsal.checks.length} local checks; ${data.rehearsal.successfulLivePacketCount} successful transactions rehearsed, including the already-completed creation. Local VM, synthetic balances; not a live Ledger test.`;
  journal(); walletAvailability(); enable();
  if (selectedMultisig) changeTab(activeTab); else { $('management-panel').hidden = false; stage('Load a Squads v3 multisig to begin'); }
}).catch(error => { $('result').textContent = error.message; });
window.addEventListener('focus', walletAvailability);
