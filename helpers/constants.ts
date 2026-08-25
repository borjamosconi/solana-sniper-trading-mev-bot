import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import { logger } from './logger';

dotenv.config();

const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

const parseBoolean = (variableName: string, fallback?: boolean): boolean => {
  const value = process.env[variableName];
  if (value === undefined || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  logger.error(`${variableName} must be "true" or "false", received "${value}"`);
  process.exit(1);
};

const parseNumber = (variableName: string, fallback?: number, min?: number): number => {
  const value = process.env[variableName];
  const raw = value === undefined || value === '' ? fallback?.toString() : value;
  if (raw === undefined) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.error(`${variableName} must be a valid number, received "${raw}"`);
    process.exit(1);
  }
  if (min !== undefined && parsed < min) {
    logger.error(`${variableName} must be >= ${min}, received ${parsed}`);
    process.exit(1);
  }
  return parsed;
};

const parseCommitment = (value: string): Commitment => {
  if (value === 'processed' || value === 'confirmed' || value === 'finalized') {
    return value;
  }
  logger.error(`COMMITMENT_LEVEL must be one of processed|confirmed|finalized, received "${value}"`);
  process.exit(1);
};

// Wallet
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = parseCommitment(retrieveEnvVariable('COMMITMENT_LEVEL', logger));
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// Bot
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const ONE_TOKEN_AT_A_TIME = parseBoolean('ONE_TOKEN_AT_A_TIME');
export const COMPUTE_UNIT_LIMIT = parseNumber('COMPUTE_UNIT_LIMIT', undefined, 1);
export const COMPUTE_UNIT_PRICE = parseNumber('COMPUTE_UNIT_PRICE', undefined, 0);
export const PRE_LOAD_EXISTING_MARKETS = parseBoolean('PRE_LOAD_EXISTING_MARKETS');
export const CACHE_NEW_MARKETS = parseBoolean('CACHE_NEW_MARKETS');
export const TRANSACTION_EXECUTOR = retrieveEnvVariable('TRANSACTION_EXECUTOR', logger);
export const CUSTOM_FEE = retrieveEnvVariable('CUSTOM_FEE', logger);
export const DRY_RUN = parseBoolean('DRY_RUN', false);
export const MAX_OPEN_POSITIONS = parseNumber('MAX_OPEN_POSITIONS', 3, 1);
export const MAX_DAILY_RAYDIUM_BUYS = parseNumber('MAX_DAILY_RAYDIUM_BUYS', 20, 1);
export const MAX_DAILY_PUMPFUN_BUY_SOL = parseNumber('MAX_DAILY_PUMPFUN_BUY_SOL', 0.05, 0);

// Buy
export const AUTO_BUY_DELAY = parseNumber('AUTO_BUY_DELAY', undefined, 0);
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
export const MAX_BUY_RETRIES = parseNumber('MAX_BUY_RETRIES', undefined, 1);
export const BUY_SLIPPAGE = parseNumber('BUY_SLIPPAGE', undefined, 0);

// Sell
export const AUTO_SELL = parseBoolean('AUTO_SELL');
export const AUTO_SELL_DELAY = parseNumber('AUTO_SELL_DELAY', undefined, 0);
export const MAX_SELL_RETRIES = parseNumber('MAX_SELL_RETRIES', undefined, 1);
export const TAKE_PROFIT = parseNumber('TAKE_PROFIT', undefined, 0);
export const STOP_LOSS = parseNumber('STOP_LOSS', undefined, 0);
export const PRICE_CHECK_INTERVAL = parseNumber('PRICE_CHECK_INTERVAL', undefined, 0);
export const PRICE_CHECK_DURATION = parseNumber('PRICE_CHECK_DURATION', undefined, 0);
export const SELL_SLIPPAGE = parseNumber('SELL_SLIPPAGE', undefined, 0);

// Filters
export const FILTER_CHECK_INTERVAL = parseNumber('FILTER_CHECK_INTERVAL', undefined, 0);
export const FILTER_CHECK_DURATION = parseNumber('FILTER_CHECK_DURATION', undefined, 0);
export const CONSECUTIVE_FILTER_MATCHES = parseNumber('CONSECUTIVE_FILTER_MATCHES', undefined, 1);
export const CHECK_IF_MUTABLE = parseBoolean('CHECK_IF_MUTABLE');
export const CHECK_IF_SOCIALS = parseBoolean('CHECK_IF_SOCIALS');
export const CHECK_IF_MINT_IS_RENOUNCED = parseBoolean('CHECK_IF_MINT_IS_RENOUNCED');
export const CHECK_IF_FREEZABLE = parseBoolean('CHECK_IF_FREEZABLE');
export const CHECK_IF_BURNED = parseBoolean('CHECK_IF_BURNED');
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
export const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);
export const USE_SNIPE_LIST = parseBoolean('USE_SNIPE_LIST');
export const SNIPE_LIST_REFRESH_INTERVAL = parseNumber('SNIPE_LIST_REFRESH_INTERVAL', undefined, 1);

// Pump.fun
export const ENABLE_PUMP_FUN = parseBoolean('ENABLE_PUMP_FUN', false);
export const ENABLE_RAYDIUM = parseBoolean('ENABLE_RAYDIUM', true);
export const PUMP_FUN_BUY_AMOUNT_SOL = parseNumber('PUMP_FUN_BUY_AMOUNT_SOL', 0.001, 0);
export const PUMP_FUN_MAX_CURVE_PROGRESS = parseNumber('PUMP_FUN_MAX_CURVE_PROGRESS', 100, 0); // %; skip if curve already filled beyond this

// Modern execution
export const DYNAMIC_PRIORITY_FEE = parseBoolean('DYNAMIC_PRIORITY_FEE', true);
export const PRIORITY_FEE_MULTIPLIER = parseNumber('PRIORITY_FEE_MULTIPLIER', 1.3, 1);
export const MAX_COMPUTE_UNIT_PRICE = parseNumber('MAX_COMPUTE_UNIT_PRICE', 5_000_000, 1);
export const SIMULATE_BEFORE_SEND = parseBoolean('SIMULATE_BEFORE_SEND', true);
export const SKIP_PREFLIGHT = parseBoolean('SKIP_PREFLIGHT', true);

// Jupiter smart routing
export const ENABLE_JUPITER_SELL = parseBoolean('ENABLE_JUPITER_SELL', true);
export const ENABLE_JUPITER_COPY_BUY = parseBoolean('ENABLE_JUPITER_COPY_BUY', true);
export const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1';
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

// Exit strategy
export const TRAILING_STOP = parseNumber('TRAILING_STOP', 12, 0);
export const TRAILING_STOP_ACTIVATION = parseNumber('TRAILING_STOP_ACTIVATION', 20, 0);
export const TAKE_PROFIT_SELL_PERCENT = parseNumber('TAKE_PROFIT_SELL_PERCENT', 100, 1);
export const BUY_COOLDOWN_MS = parseNumber('BUY_COOLDOWN_MS', 60_000, 0);

// Risk
export const CIRCUIT_BREAKER_MAX_FAILURES = parseNumber('CIRCUIT_BREAKER_MAX_FAILURES', 4, 0);
export const CIRCUIT_BREAKER_PAUSE_MS = parseNumber('CIRCUIT_BREAKER_PAUSE_MS', 300_000, 0);
export const CHECK_TOP_HOLDER = parseBoolean('CHECK_TOP_HOLDER', true);
export const MAX_TOP_HOLDER_PERCENT = parseNumber('MAX_TOP_HOLDER_PERCENT', 50, 1);

// Copy trade
export const ENABLE_COPY_TRADE = parseBoolean('ENABLE_COPY_TRADE', false);
export const COPY_WALLETS = (process.env.COPY_WALLETS || '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

// Cross-DEX arbitrage
export const ENABLE_ARBITRAGE = parseBoolean('ENABLE_ARBITRAGE', false);
export const ARB_INTERVAL_MS = parseNumber('ARB_INTERVAL_MS', 2500, 250);
export const ARB_AMOUNT_SOL = parseNumber('ARB_AMOUNT_SOL', 0.05, 0);
export const ARB_MIN_PROFIT_BPS = parseNumber('ARB_MIN_PROFIT_BPS', 40, 1);
export const ARB_SLIPPAGE_BPS = parseNumber('ARB_SLIPPAGE_BPS', 50, 1);
export const ARB_MAX_DAILY_SOL = parseNumber('ARB_MAX_DAILY_SOL', 0.25, 0);
export const ARB_PAIRS = (process.env.ARB_PAIRS || 'SOL/USDC,SOL/USDT')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
export const ARB_DEX_GROUP_A = process.env.ARB_DEX_GROUP_A || 'Raydium,Raydium CLMM,Raydium CPMM';
export const ARB_DEX_GROUP_B = process.env.ARB_DEX_GROUP_B || 'Whirlpool,Meteora DLMM,Meteora,Pump.fun Amm';
