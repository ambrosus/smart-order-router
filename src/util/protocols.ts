import { Protocol } from '@airdao/astra-router-sdk';

export const TO_PROTOCOL = (protocol: string): Protocol => {
  switch (protocol.toLowerCase()) {
    case 'cl':
      return Protocol.CL;
    case 'classic':
      return Protocol.Classic;
    case 'mixed':
      return Protocol.MIXED;
    default:
      throw new Error(`Unknown protocol: {id}`);
  }
};
