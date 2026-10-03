/**
 * Read-only surface of @sats402/core: types, binding construction, and
 * verification only.
 *
 * This entry point deliberately excludes key derivation and signing
 * (`keys.ts`, the form/sign path in `bind.ts`). Anything importing this
 * subpath cannot sign or broadcast. That is how @sats402/verify stays keyless
 * and greppably so.
 */
export * from './types.js';
export { buildBoundMessage } from './binding.js';
export {
  SettlementLookupError,
  fetchSettlement,
  verifyPayment,
  verifySettlement,
  replayKey,
} from './verify.js';
