import { ChainId, Currency } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';

import { CLRoute } from '../../../router';

// Cost for crossing an uninitialized tick.
export const COST_PER_UNINIT_TICK = BigNumber.from(0);

export const BASE_SWAP_COST = (id: ChainId): BigNumber => {
  switch (id) {
    case ChainId.MAINNET:
    case ChainId.TESTNET:
    case ChainId.DEVNET:
      return BigNumber.from(0);
    default:
      return BigNumber.from(0);
  }
};
export const COST_PER_INIT_TICK = (id: ChainId): BigNumber => {
  switch (id) {
    case ChainId.MAINNET:
    case ChainId.TESTNET:
    case ChainId.DEVNET:
      return BigNumber.from(31000);
    default:
      return BigNumber.from(31000);
  }
};

export const COST_PER_HOP = (id: ChainId): BigNumber => {
  switch (id) {
    case ChainId.MAINNET:
    case ChainId.TESTNET:
    case ChainId.DEVNET:
      return BigNumber.from(80000);
    default:
      return BigNumber.from(80000);
  }
};

export const SINGLE_HOP_OVERHEAD = (_id: ChainId): BigNumber => {
  return BigNumber.from(15000);
};

export const TOKEN_OVERHEAD = (id: ChainId, route: CLRoute): BigNumber => {
  return BigNumber.from(0);
};

// TODO: change per chain
export const NATIVE_WRAP_OVERHEAD = (id: ChainId): BigNumber => {
  switch (id) {
    default:
      return BigNumber.from(27938);
  }
};

export const NATIVE_UNWRAP_OVERHEAD = (id: ChainId): BigNumber => {
  switch (id) {
    default:
      return BigNumber.from(36000);
  }
};

export const NATIVE_OVERHEAD = (
  chainId: ChainId,
  amount: Currency,
  quote: Currency
): BigNumber => {
  if (amount.isNative) {
    // need to wrap amb in
    return NATIVE_WRAP_OVERHEAD(chainId);
  }
  if (quote.isNative) {
    // need to unwrap amb out
    return NATIVE_UNWRAP_OVERHEAD(chainId);
  }
  return BigNumber.from(0);
};
