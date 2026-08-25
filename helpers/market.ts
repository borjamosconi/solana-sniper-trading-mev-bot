import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { MARKET_STATE_LAYOUT_V3 } from '@raydium-io/raydium-sdk';

export interface MinimalMarketLayoutV3 {
  eventQueue: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}

export function toMinimalMarket(decoded: {
  eventQueue: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}): MinimalMarketLayoutV3 {
  return {
    eventQueue: decoded.eventQueue,
    bids: decoded.bids,
    asks: decoded.asks,
    baseVault: decoded.baseVault,
    quoteVault: decoded.quoteVault,
  };
}

export async function getMinimalMarketV3(
  connection: Connection,
  marketId: PublicKey,
  commitment?: Commitment,
): Promise<MinimalMarketLayoutV3> {
  const marketInfo = await connection.getAccountInfo(marketId, { commitment });
  if (!marketInfo?.data) {
    throw new Error(`OpenBook market not found: ${marketId.toBase58()}`);
  }

  const decoded = MARKET_STATE_LAYOUT_V3.decode(marketInfo.data);
  return toMinimalMarket(decoded);
}
