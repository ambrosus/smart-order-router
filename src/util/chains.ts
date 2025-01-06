import { Amber, ChainId, NativeCurrency, Token } from '@airdao/astra-sdk-core';

export const SUPPORTED_CHAINS: ChainId[] = [
  ChainId.MAINNET,
  ChainId.TESTNET,
  ChainId.DEVNET,
];

export const CLASSIC_SUPPORTED = [
  ChainId.MAINNET,
  ChainId.TESTNET,
  ChainId.DEVNET,
];

export const ID_TO_CHAIN_ID = (id: number): ChainId => {
  switch (id) {
    case 16718:
      return ChainId.MAINNET;
    case 22040:
      return ChainId.TESTNET;
    case 30746:
      return ChainId.DEVNET;
    default:
      throw new Error(`Unknown chain id: ${id}`);
  }
};

export enum ChainName {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
  DEVNET = 'devnet',
}

export enum NativeCurrencyName {
  AMBER = 'AMB',
}

export const NATIVE_NAMES_BY_ID: { [chainId: number]: string[] } = {
  [ChainId.MAINNET]: [
    'AMB',
    'AMBER',
    '0x0000000000000000000000000000000000000000',
  ],
  [ChainId.TESTNET]: [
    'AMB',
    'AMBER',
    '0x0000000000000000000000000000000000000000',
  ],
  [ChainId.DEVNET]: [
    'AMB',
    'AMBER',
    '0x0000000000000000000000000000000000000000',
  ],
};

export const NATIVE_CURRENCY: { [chainId: number]: NativeCurrencyName } = {
  [ChainId.MAINNET]: NativeCurrencyName.AMBER,
  [ChainId.DEVNET]: NativeCurrencyName.AMBER,
  [ChainId.TESTNET]: NativeCurrencyName.AMBER,
};

export const ID_TO_NETWORK_NAME = (id: number): ChainName => {
  switch (id) {
    case 16718:
      return ChainName.MAINNET;
    case 22040:
      return ChainName.TESTNET;
    case 30746:
      return ChainName.DEVNET;
    default:
      throw new Error(`Unknown chain id: ${id}`);
  }
};

export const CHAIN_IDS_LIST = Object.values(ChainId).map((c) =>
  c.toString()
) as string[];

export const ID_TO_PROVIDER = (id: ChainId): string => {
  switch (id) {
    case ChainId.MAINNET:
      return process.env.JSON_RPC_PROVIDER!;
    case ChainId.TESTNET:
      return process.env.JSON_RPC_PROVIDER_TESTNET!;
    case ChainId.DEVNET:
      return process.env.JSON_RPC_PROVIDER_DEVNET!;
    default:
      throw new Error(`Chain id: ${id} not supported`);
  }
};

export const WRAPPED_NATIVE_CURRENCY: { [chainId in ChainId]: Token } = {
  [ChainId.MAINNET]: new Token(
    16718,
    '0x2b2d892C3fe2b4113dd7aC0D2c1882AF202FB28F',
    18,
    'SAMB',
    'Synthetic Amber'
  ),
  [ChainId.TESTNET]: new Token(
    22040,
    '0x2Cf845b49e1c4E5D657fbBF36E97B7B5B7B7b74b',
    18,
    'SAMB',
    'Synthetic Amber'
  ),
  [ChainId.DEVNET]: new Token(
    30746,
    '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // TODO
    18,
    'SAMB',
    'Synthetic Amber'
  ),
};

export class ExtendedAmber extends Amber {
  public get wrapped(): Token {
    if (this.chainId in WRAPPED_NATIVE_CURRENCY) {
      return WRAPPED_NATIVE_CURRENCY[this.chainId as ChainId];
    }
    throw new Error('Unsupported chain ID');
  }

  private static _cachedExtendedAmber: { [chainId: number]: NativeCurrency } =
    {};

  public static onChain(chainId: number): ExtendedAmber {
    return (
      this._cachedExtendedAmber[chainId] ??
      (this._cachedExtendedAmber[chainId] = new ExtendedAmber(chainId))
    );
  }
}

const cachedNativeCurrency: { [chainId: number]: NativeCurrency } = {};

export function nativeOnChain(chainId: number): NativeCurrency {
  return cachedNativeCurrency[chainId] as NativeCurrency;
}
