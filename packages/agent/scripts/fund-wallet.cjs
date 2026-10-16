#!/usr/bin/env node
// fund-wallet: make faucet coins spendable in the Sats402 ledger.
//
// The faucet sends L1 coins to a user's P2TR address (Sats402's `userAddress`),
// but ledger value lives in VTXOs produced from a vault deposit. This tool does
// the two L1 steps in one command:
//   1. sweep the P2TR faucet coins to the wallet's own P2WPKH address
//      (taproot key-path spend, one signature),
//   2. deposit into a fresh vault with the SDK's own flow.
// After the deposit confirms on L1, the vault is registered and the VTXOs are
// minted (see the printed next step).
//
// Three SDK traps are handled here (each cost real debugging time):
//   - the aggregator's signer needs `addressIndex` on every UTXO it signs
//     (`signerFor(utxo.change, utxo.addressIndex)`), so injected 0-conf outputs
//     must carry it;
//   - `depositToVault` runs its own `scantxoutset` and throws through with
//     -8 "Scan already in progress" regardless of any caller-side queue, so the
//     money call gets a bounded retry for that one signature;
//   - an unconfirmed sweep output is invisible to `sync()`, so it is injected
//     (0-conf) instead, with the run recorded in a state file to stay
//     idempotent across re-runs.
//
// Usage:
//   SATS402_MNEMONIC="..." node scripts/fund-wallet.cjs [--amount 90000]
//   node scripts/fund-wallet.cjs --mnemonic-env SATS402_S2_MNEMONIC --dry-run
//
// The mnemonic is read from the named environment variable (default
// SATS402_MNEMONIC) and is never accepted as a command-line argument.

const fs = require('fs');
const os = require('os');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const { BitcoinCoreRpcClient, WalletAggregator, Keystore, getNetwork } = require('@tachibtc/taurus-wallet-aggregator');
const { createVault, depositToVault, verifyVaultP2tr, normalizeTaprootSigner } = require('@tachibtc/taurus-vault-core');

const DEFAULTS = {
  network: 'signet',
  daemonUrl: process.env.SATS402_DAEMON ?? 'https://rpc-signet.tachibtc.com',
  amountSats: 90_000n,
  feeRateSatVb: 2,
  sweepFeeSats: 300n, // 1-in 1-out P2TR key-path spend ~= 111 vB at 2 sat/vB
  mnemonicEnv: 'SATS402_MNEMONIC',
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--amount') out.amountSats = BigInt(argv[++i]);
    else if (a === '--mnemonic-env') out.mnemonicEnv = argv[++i];
    else if (a === '--network') out.network = argv[++i];
    else if (a === '--daemon') out.daemonUrl = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      console.error('usage: fund-wallet [--amount <sats>] [--mnemonic-env <VAR>] [--network signet] [--daemon <url>] [--dry-run]');
      process.exit(2);
    }
  }
  return out;
}

// scantxoutset allows one scan at a time; -8 is transient.
async function scanAddress(daemonUrl, address) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await (await fetch(`${daemonUrl.replace(/\/$/, '')}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'scantxoutset', params: ['start', [`addr(${address})`]] }),
    })).json();
    if (r.result) return r.result.unspents || [];
    await new Promise((res) => setTimeout(res, 3000));
  }
  return [];
}

async function main() {
  const opts = parseArgs(process.argv);
  const mnemonic = (process.env[opts.mnemonicEnv] || '').trim();
  if (!mnemonic) {
    console.error(`no mnemonic: set ${opts.mnemonicEnv} in the environment (never pass mnemonics as arguments)`);
    process.exit(2);
  }

  // identity + x-only come from Sats402's own derivation, so the sweep signs
  // exactly the key the product uses
  const core = require(path.join(__dirname, '..', '..', 'core', 'dist', 'index.js'));
  const identity = core.deriveIdentity(mnemonic, opts.network, 0);
  const net = getNetwork(opts.network);
  const rpc = new BitcoinCoreRpcClient({ url: opts.daemonUrl });
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: opts.network, rpc });
  const wallet = aggregator.addAccount({ addressType: 'p2wpkh' });
  const sweepDest = wallet.receiveAddress;
  const destScript = Buffer.from(bitcoin.address.toOutputScript(sweepDest, net)).toString('hex');

  const statePath = path.join(os.tmpdir(), `sats402-fund-${opts.network}-${identity.xOnly.slice(0, 16)}.json`);
  let pending = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const faucetUtxos = pending ? [] : await scanAddress(opts.daemonUrl, identity.userAddress);

  console.log(`wallet:        ${identity.userAddress}`);
  console.log(`sweep target:  ${sweepDest}`);
  console.log(`P2TR coins:    ${faucetUtxos.length} confirmed`);
  console.log(`pending sweep: ${pending ? pending.txid : 'none'}`);
  if (opts.dryRun) {
    console.log('dry run: nothing broadcast');
    return;
  }

  if (faucetUtxos.length) {
    const totalIn = faucetUtxos.reduce((s, u) => s + BigInt(Math.round(Number(u.amount) * 1e8)), 0n);
    const sendSats = totalIn - opts.sweepFeeSats;
    const psbt = new bitcoin.Psbt({ network: net });
    for (const u of faucetUtxos) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: { script: Uint8Array.from(Buffer.from(u.scriptPubKey, 'hex')), value: BigInt(Math.round(Number(u.amount) * 1e8)) },
        tapInternalKey: Uint8Array.from(Buffer.from(identity.xOnly, 'hex')),
      });
    }
    psbt.addOutput({ address: sweepDest, value: sendSats });
    const node = Keystore.fromMnemonic(mnemonic, '', net, 'p2wpkh', 0).signerFor(false, 0);
    const signer = normalizeTaprootSigner({
      publicKey: Buffer.from(node.publicKey),
      sign: (h) => Buffer.from(node.sign(h)),
      signSchnorr: (h) => Buffer.from(node.signSchnorr(h)),
    });
    for (let i = 0; i < faucetUtxos.length; i++) psbt.signInput(i, signer);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const outs = tx.outs.reduce((s, o) => s + BigInt(o.value), 0n);
    const fee = totalIn - outs;
    if (fee !== opts.sweepFeeSats) throw new Error(`sweep fee ${fee} != expected ${opts.sweepFeeSats}`);
    const txid = await rpc.call('sendrawtransaction', [tx.toHex()]);
    console.log(`sweep broadcast: ${txid}`);
    pending = { txid, valueSats: sendSats.toString() };
    fs.writeFileSync(statePath, JSON.stringify(pending));
  }

  // the sweep is unconfirmed on re-runs: inject its pending output (0-conf)
  if (pending) {
    wallet.utxos.push({
      txid: pending.txid,
      vout: 0,
      valueSats: BigInt(pending.valueSats),
      address: sweepDest,
      scriptPubKey: destScript,
      height: 0,
      confirmations: 0,
      coinbase: false,
      derivationPath: "m/84'/1'/0'/0/0",
      change: false,
      addressIndex: 0,
    });
  } else {
    await wallet.sync();
    if (wallet.balance.total < opts.amountSats + 500n) {
      console.log(`nothing to fund: ${wallet.balance.total} sats spendable at ${identity.userAddress}`);
      console.log(`top up at https://faucet.tachibtc.com (open it in a browser, sign in, and claim for this address)`);
      return;
    }
  }

  const vault = await createVault({ network: opts.network, userWallet: wallet, validators: { endpoint: `${opts.daemonUrl.replace(/\/$/, '')}/tachi_validators` } });
  verifyVaultP2tr(vault.p2tr);

  let deposit = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      deposit = await depositToVault({
        vault,
        userWallet: wallet,
        rpc,
        amountSats: opts.amountSats,
        feeRateSatVb: opts.feeRateSatVb,
        skipSync: !!pending,
      });
      break;
    } catch (err) {
      if (!/Scan already in progress/.test(String(err?.cause?.message || err?.message))) throw err;
      console.log(`deposit attempt ${attempt}: scan busy (retrying in 4s)`);
      await new Promise((res) => setTimeout(res, 4000));
    }
  }
  if (!deposit) throw new Error('deposit did not go through after retries');

  const inputsSum = deposit.inputs.reduce((s, x) => s + (x.valueSats ?? x.amountSats ?? 0n), 0n);
  if (deposit.feeSats !== inputsSum - deposit.amountSats - deposit.changeSats) {
    throw new Error('money assert failed: fee != inputs - outputs');
  }
  console.log(`deposit broadcast: ${deposit.txid}`);
  console.log(`  vault:   ${deposit.vaultAddress}`);
  console.log(`  amount:  ${deposit.amountSats} sats  fee: ${deposit.feeSats}  change: ${deposit.changeSats}`);
  console.log(`next: after the deposit confirms on L1, register the vault to mint spendable VTXOs`);
  console.log(`      (funding outpoint ${deposit.txid}:0, vault ${deposit.vaultAddress})`);
  fs.writeFileSync(statePath.replace('.json', '-deposit.json'), JSON.stringify({
    depositTxid: deposit.txid,
    vaultAddress: deposit.vaultAddress,
    amountSats: deposit.amountSats.toString(),
  }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
