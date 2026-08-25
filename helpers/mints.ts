import { PublicKey } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const SOL_MINT_PK = new PublicKey(SOL_MINT);
export const USDC_MINT_PK = new PublicKey(USDC_MINT);
export const USDT_MINT_PK = new PublicKey(USDT_MINT);

const SYMBOL_TO_MINT: Record<string, string> = {
  SOL: SOL_MINT,
  WSOL: SOL_MINT,
  USDC: USDC_MINT,
  USDT: USDT_MINT,
};

export function mintFromSymbol(symbol: string): string | undefined {
  return SYMBOL_TO_MINT[symbol.trim().toUpperCase()];
}

export function parseMintPair(pair: string): { inputMint: string; outputMint: string; label: string } | undefined {
  const [left, right] = pair.split(/[\/\-]/).map((part) => part.trim());
  if (!left || !right) return undefined;

  const inputMint = mintFromSymbol(left) ?? (left.length >= 32 ? left : undefined);
  const outputMint = mintFromSymbol(right) ?? (right.length >= 32 ? right : undefined);
  if (!inputMint || !outputMint || inputMint === outputMint) return undefined;

  return { inputMint, outputMint, label: `${left}/${right}`.toUpperCase() };
}
