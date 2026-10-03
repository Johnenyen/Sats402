/**
 * Key derivation and signing for Sats402.
 *
 * Identity derivation and signers come from Tachi's own TAURUS SDK
 * (`@tachibtc/taurus-vault-core`, `@tachibtc/taurus-wallet-aggregator`): the
 * owner key is the x-only public key of the derived user key, which is exactly
 * how the Tachi ledger identifies VTXO ownership.
 */
import * as vc from '@tachibtc/taurus-vault-core';
import * as agg from '@tachibtc/taurus-wallet-aggregator';
import { bech32m } from '@scure/base';

/** Minimal signer for bound-message signatures: BIP-340 over 32-byte messages. */
export interface SchnorrSigner {
  publicKey: Uint8Array;
  signSchnorr: (msg32: Uint8Array) => Uint8Array;
}

/** Tachi SDK signer shape: BIP-340 Schnorr plus ECDSA for PSBT paths. */
export interface Sats402Signer extends SchnorrSigner {
  sign: (msg: Uint8Array) => Uint8Array;
}

export interface Identity {
  /** 64 lowercase hex, x-only public key: the Tachi owner key. */
  xOnly: string;
  /** The Tachi user key derivation record (for vault reconstruction). */
  userKeyDescriptor: unknown;
  /** Regtest P2TR (bech32m) address of the owner key. */
  userAddress: string;
  signer: Sats402Signer;
}

/** Regtest bech32m human-readable part. */
const HRP_REGTEST = 'bcrt';

/**
 * P2TR address for an x-only key: witness v1, 32-byte program (BIP-350).
 * Matches the Tachi ledger's user-address encoding.
 */
export function userAddressForXOnly(xOnly: string, network = 'regtest'): string {
  if (!/^[0-9a-f]{64}$/.test(xOnly)) {
    throw new Error('xOnly must be 64 lowercase hex characters');
  }
  const program = Uint8Array.from(xOnly.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const words = [1, ...bech32m.toWords(program)];
  return bech32m.encode(network === 'regtest' ? HRP_REGTEST : 'bcrt', words);
}

/**
 * Derive an identity from a BIP-39 mnemonic at the given receive index.
 * `network` is a Tachi network name understood by the TAURUS SDK (`regtest`).
 */
export function deriveIdentity(mnemonic: string, network = 'regtest', index = 0): Identity {
  const netObj = agg.getNetwork(network);
  const desc = vc.deriveUserKey(mnemonic, netObj, { index }) as { publicKey: string };
  const xOnly = desc.publicKey.replace(/^(02|03)/, '').toLowerCase();

  const ks = agg.Keystore.fromMnemonic(mnemonic, '', netObj, 'p2wpkh', 0);
  const node = ks.signerFor(false, index);
  const signer = vc.normalizeTaprootSigner({
    publicKey: Buffer.from(node.publicKey),
    sign: (h: Buffer) => Buffer.from(node.sign(h)),
    signSchnorr: (h: Buffer) => Buffer.from(node.signSchnorr(h)),
  });

  return {
    xOnly,
    userKeyDescriptor: desc,
    userAddress: userAddressForXOnly(xOnly, network),
    signer: {
      publicKey: new Uint8Array(signer.publicKey),
      sign: (msg: Uint8Array) => new Uint8Array(signer.sign(Buffer.from(msg))),
      signSchnorr: (msg32: Uint8Array) => new Uint8Array(signer.signSchnorr(Buffer.from(msg32))),
    },
  };
}

/** Hex helper re-exported for tests and adapters. */
export function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
