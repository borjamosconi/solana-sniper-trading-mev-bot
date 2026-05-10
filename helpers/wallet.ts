import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export function getWallet(wallet: string): Keypair {
  const normalized = wallet.trim().replace(/^['"]|['"]$/g, '');

  // most likely someone pasted the private key in binary format
  if (normalized.startsWith('[')) {
    const raw = new Uint8Array(JSON.parse(normalized));
    return Keypair.fromSecretKey(raw);
  }

  // most likely someone pasted mnemonic
  if (normalized.split(/\s+/).length > 1) {
    const seed = mnemonicToSeedSync(normalized, '');
    const path = `m/44'/501'/0'/0'`; // we assume it's first path
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
  }

  // support hex keys too:
  // - 64 hex chars  => 32-byte seed
  // - 128 hex chars => 64-byte secret key
  const hex = normalized.startsWith('0x') ? normalized.slice(2) : normalized;
  if (/^[0-9a-fA-F]+$/.test(hex)) {
    if (hex.length === 64) {
      return Keypair.fromSeed(new Uint8Array(Buffer.from(hex, 'hex')));
    }
    if (hex.length === 128) {
      return Keypair.fromSecretKey(new Uint8Array(Buffer.from(hex, 'hex')));
    }
    throw new Error('Invalid hex private key length. Use 64 or 128 hex characters.');
  }

  // most likely someone pasted base58 encoded private key
  try {
    return Keypair.fromSecretKey(bs58.decode(normalized));
  } catch {
    throw new Error(
      'Invalid PRIVATE_KEY format. Supported: base58 secret key, JSON array ([...]), mnemonic phrase, or hex (64/128 chars).',
    );
  }
}
