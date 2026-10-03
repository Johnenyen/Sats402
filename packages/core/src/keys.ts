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

/** A signer producing BIP-340 Schnorr signatures over 32-byte messages. */
export interface SchnorrSigner {
  publicKey: Uint8Array;
  signSchnorr: (msg32: Uint8Array) => Uint8Array;
}

export interface Identity {
  /** 64 lowercase hex, x-only public key: the Tachi owner key. */
  xOnly: string;
  signer: SchnorrSigner;
}

function hex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive an identity from a BIP-39 mnemonic at the given receive index.
 * `network` is a Tachi network name understood by the TAURUS SDK (`regtest`).
 */
export function deriveIdentity(mnemonic: string, network = 'regtest', index = 0): Identity {
  const netObj = agg.getNetwork(network);
  const desc = vc.deriveUserKey(mnemonic, netObj, { index }) as { publicKey: string };
  const xOnly = desc.publicKey.replace(/^(02|03)/, '');

  const ks = agg.Keystore.fromMnemonic(mnemonic, '', netObj, 'p2wpkh', 0);
  const node = ks.signerFor(false, index);
  const signer = vc.normalizeTaprootSigner({
    publicKey: Buffer.from(node.publicKey),
    sign: (h: Buffer) => Buffer.from(node.sign(h)),
    signSchnorr: (h: Buffer) => Buffer.from(node.signSchnorr(h)),
  });

  return {
    xOnly,
    signer: {
      publicKey: new Uint8Array(signer.publicKey),
      signSchnorr: (msg32: Uint8Array) => new Uint8Array(signer.signSchnorr(Buffer.from(msg32))),
    },
  };
}

/** Hex helper re-exported for tests and adapters. */
export const toHex = hex;
