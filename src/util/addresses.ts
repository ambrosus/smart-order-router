import { CHAIN_TO_ADDRESSES_MAP, ChainId, Token } from '@airdao/astra-sdk-core';

export const CL_CORE_FACTORY_ADDRESSES: AddressMap = {
  [ChainId.MAINNET]:
    CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].clCoreFactoryAddress,
  [ChainId.TESTNET]:
    CHAIN_TO_ADDRESSES_MAP[ChainId.TESTNET].clCoreFactoryAddress,
  [ChainId.DEVNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.DEVNET].clCoreFactoryAddress,
};

export const QUOTER_CLASSIC_ADDRESSES: AddressMap = {
  [ChainId.MAINNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].quoterAddress,
  [ChainId.TESTNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.TESTNET].quoterAddress,
  [ChainId.DEVNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.DEVNET].quoterAddress,
};

export const ASTRA_MULTICALL_ADDRESSES: AddressMap = {
  [ChainId.MAINNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].multicallAddress,
  [ChainId.TESTNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.TESTNET].multicallAddress,
  [ChainId.DEVNET]: CHAIN_TO_ADDRESSES_MAP[ChainId.DEVNET].multicallAddress,
};

export const SWAP_ROUTER_ADDRESSES = (chainId: number): string => {
  if (chainId == ChainId.MAINNET) {
    return CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].swapRouterAddress as string;
  }
  if (chainId == ChainId.TESTNET) {
    return CHAIN_TO_ADDRESSES_MAP[ChainId.TESTNET].swapRouterAddress as string;
  }
  if (chainId == ChainId.DEVNET) {
    return CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].swapRouterAddress as string;
  }
  return CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].swapRouterAddress as string;
};

export const CL_MIGRATOR_ADDRESS =
  CHAIN_TO_ADDRESSES_MAP[ChainId.MAINNET].clMigratorAddress;
export const MULTICALL2_ADDRESS = '0xeEB35b2b13B7F312684c4E0Af670475F0698F7A0';

export type AddressMap = { [chainId: number]: string | undefined };

export const SAMB: {
  [chainId in Exclude<
    ChainId,
    ChainId.MAINNET | ChainId.TESTNET | ChainId.DEVNET
  >]: Token;
} = {
  [ChainId.MAINNET]: new Token(
    ChainId.MAINNET,
    '0x2b2d892C3fe2b4113dd7aC0D2c1882AF202FB28F',
    18,
    'SAMB',
    'Synthetic Amber'
  ),
  [ChainId.TESTNET]: new Token(
    ChainId.TESTNET,
    '0x2Cf845b49e1c4E5D657fbBF36E97B7B5B7B7b74b',
    18,
    'SAMB',
    'Synthetic Amber'
  ),
  [ChainId.DEVNET]: new Token(
    ChainId.DEVNET,
    '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // TODO
    18,
    'SAMB',
    'Synthetic Amber'
  ),
};
