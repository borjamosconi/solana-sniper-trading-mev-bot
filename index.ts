import { MarketCache, PoolCache, PumpFunCache } from './cache';
import { Listeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair, Logs, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  PRE_LOAD_EXISTING_MARKETS,
  LOG_LEVEL,
  CHECK_IF_MINT_IS_RENOUNCED,
  CHECK_IF_FREEZABLE,
  CHECK_IF_BURNED,
  QUOTE_MINT,
  MAX_POOL_SIZE,
  MIN_POOL_SIZE,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  USE_SNIPE_LIST,
  ONE_TOKEN_AT_A_TIME,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  CACHE_NEW_MARKETS,
  TAKE_PROFIT,
  STOP_LOSS,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  SNIPE_LIST_REFRESH_INTERVAL,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  FILTER_CHECK_INTERVAL,
  FILTER_CHECK_DURATION,
  CONSECUTIVE_FILTER_MATCHES,
  ENABLE_PUMP_FUN,
  ENABLE_RAYDIUM,
  PUMP_FUN_BUY_AMOUNT_SOL,
  PUMP_FUN_MAX_CURVE_PROGRESS,
  PUMP_FUN_PROGRAM_ID,
  DRY_RUN,
  MAX_OPEN_POSITIONS,
  MAX_DAILY_RAYDIUM_BUYS,
  MAX_DAILY_PUMPFUN_BUY_SOL,
  TRAILING_STOP,
  TRAILING_STOP_ACTIVATION,
  TAKE_PROFIT_SELL_PERCENT,
  BUY_COOLDOWN_MS,
  DYNAMIC_PRIORITY_FEE,
  PRIORITY_FEE_MULTIPLIER,
  MAX_COMPUTE_UNIT_PRICE,
  SIMULATE_BEFORE_SEND,
  ENABLE_JUPITER_SELL,
  ENABLE_JUPITER_COPY_BUY,
  JUPITER_API_URL,
  JUPITER_API_KEY,
  CIRCUIT_BREAKER_MAX_FAILURES,
  CIRCUIT_BREAKER_PAUSE_MS,
  ENABLE_COPY_TRADE,
  COPY_WALLETS,
  ENABLE_ARBITRAGE,
  ARB_INTERVAL_MS,
  ARB_AMOUNT_SOL,
  ARB_MIN_PROFIT_BPS,
  ARB_SLIPPAGE_BPS,
  ARB_MAX_DAILY_SOL,
  ARB_PAIRS,
  ARB_DEX_GROUP_A,
  ARB_DEX_GROUP_B,
  CHECK_TOP_HOLDER,
  MAX_TOP_HOLDER_PERCENT,
  JupiterClient,
  toMinimalMarket,
} from './helpers';
import { version } from './package.json';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { CircuitBreaker } from './risk';
import { ArbitrageEngine } from './arbitrage';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

function printDetails(wallet: Keypair, quoteToken: Token, bot: Bot) {
  logger.info(`  
                                        ..   :-===++++-     
                                .-==+++++++- =+++++++++-    
            ..:::--===+=.=:     .+++++++++++:=+++++++++:    
    .==+++++++++++++++=:+++:    .+++++++++++.=++++++++-.    
    .-+++++++++++++++=:=++++-   .+++++++++=:.=+++++-::-.    
     -:+++++++++++++=:+++++++-  .++++++++-:- =+++++=-:      
      -:++++++=++++=:++++=++++= .++++++++++- =+++++:        
       -:++++-:=++=:++++=:-+++++:+++++====--:::::::.        
        ::=+-:::==:=+++=::-:--::::::::::---------::.        
         ::-:  .::::::::.  --------:::..                    
          :-    .:.-:::.                                    

          WARP DRIVE ACTIVATED 🚀🐟
          Made with ❤️ by humans.
          Version: ${version}                                          
  `);

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);

  logger.info('- Bot -');
  logger.info(
    `Using ${TRANSACTION_EXECUTOR} executer: ${bot.isWarp || bot.isJito || TRANSACTION_EXECUTOR === 'default'}`,
  );
  if (bot.isWarp || bot.isJito) {
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
    logger.info(`Dynamic priority fee: ${botConfig.dynamicPriorityFee} x${botConfig.priorityFeeMultiplier}`);
  }

  logger.info(`Single token at the time: ${botConfig.oneTokenAtATime}`);
  logger.info(`Dry run mode: ${botConfig.dryRun}`);
  logger.info(`Simulate before send: ${botConfig.simulateBeforeSend}`);
  logger.info(`Max open positions: ${botConfig.maxOpenPositions}`);
  logger.info(`Max daily Raydium buys: ${botConfig.maxDailyRaydiumBuys}`);
  logger.info(`Max daily pump.fun buy SOL: ${botConfig.maxDailyPumpFunBuySol}`);
  logger.info(`Pre load existing markets: ${PRE_LOAD_EXISTING_MARKETS}`);
  logger.info(`Cache new markets: ${CACHE_NEW_MARKETS}`);
  logger.info(`Log level: ${LOG_LEVEL}`);

  logger.info('- Buy -');
  logger.info(`Buy amount: ${botConfig.quoteAmount.toFixed()} ${botConfig.quoteToken.name}`);
  logger.info(`Auto buy delay: ${botConfig.autoBuyDelay} ms`);
  logger.info(`Max buy retries: ${botConfig.maxBuyRetries}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);
  logger.info(`Buy cooldown: ${botConfig.buyCooldownMs} ms`);

  logger.info('- Sell / exits -');
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Auto sell delay: ${botConfig.autoSellDelay} ms`);
  logger.info(`Max sell retries: ${botConfig.maxSellRetries}`);
  logger.info(`Sell slippage: ${botConfig.sellSlippage}%`);
  logger.info(`Take profit: ${botConfig.takeProfit}% (sell ${botConfig.takeProfitSellPercent}%)`);
  logger.info(`Stop loss: ${botConfig.stopLoss}%`);
  logger.info(`Trailing stop: ${botConfig.trailingStop}% after +${botConfig.trailingStopActivation}%`);
  logger.info(`Jupiter sell routing: ${botConfig.enableJupiterSell}`);

  logger.info('- Snipe list -');
  logger.info(`Snipe list: ${botConfig.useSnipeList}`);
  logger.info(`Snipe list refresh interval: ${SNIPE_LIST_REFRESH_INTERVAL} ms`);

  if (botConfig.useSnipeList) {
    logger.info('- Filters -');
    logger.info(`Filters are disabled when snipe list is on`);
  } else {
    logger.info('- Filters -');
    logger.info(`Filter check interval: ${botConfig.filterCheckInterval} ms`);
    logger.info(`Filter check duration: ${botConfig.filterCheckDuration} ms`);
    logger.info(`Consecutive filter matches: ${botConfig.consecutiveMatchCount}`);
    logger.info(`Check renounced: ${botConfig.checkRenounced}`);
    logger.info(`Check freezable: ${botConfig.checkFreezable}`);
    logger.info(`Check burned: ${botConfig.checkBurned}`);
    logger.info(`Check top holder: ${CHECK_TOP_HOLDER} (max ${MAX_TOP_HOLDER_PERCENT}%)`);
    logger.info(`Min pool size: ${botConfig.minPoolSize.toFixed()}`);
    logger.info(`Max pool size: ${botConfig.maxPoolSize.toFixed()}`);
  }

  logger.info('- Modern modules -');
  logger.info(`Copy trade: ${ENABLE_COPY_TRADE} wallets=${COPY_WALLETS.length}`);
  logger.info(`Arbitrage: ${ENABLE_ARBITRAGE} pairs=${ARB_PAIRS.join(',')}`);
  logger.info(`Jupiter URL: ${JUPITER_API_URL}`);

  logger.info('------- CONFIGURATION END -------');
  logger.info('Bot is running! Press CTRL + C to stop it.');
}

const runListener = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Bot is starting...');

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  const pumpFunCache = new PumpFunCache();
  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE);
      break;
    }
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  const jupiter = new JupiterClient(JUPITER_API_URL, JUPITER_API_KEY || undefined);
  const breaker = new CircuitBreaker(CIRCUIT_BREAKER_MAX_FAILURES, CIRCUIT_BREAKER_PAUSE_MS);

  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    checkRenounced: CHECK_IF_MINT_IS_RENOUNCED,
    checkFreezable: CHECK_IF_FREEZABLE,
    checkBurned: CHECK_IF_BURNED,
    minPoolSize: new TokenAmount(quoteToken, MIN_POOL_SIZE, false),
    maxPoolSize: new TokenAmount(quoteToken, MAX_POOL_SIZE, false),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    oneTokenAtATime: ONE_TOKEN_AT_A_TIME,
    useSnipeList: USE_SNIPE_LIST,
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    takeProfit: TAKE_PROFIT,
    stopLoss: STOP_LOSS,
    buySlippage: BUY_SLIPPAGE,
    sellSlippage: SELL_SLIPPAGE,
    priceCheckInterval: PRICE_CHECK_INTERVAL,
    priceCheckDuration: PRICE_CHECK_DURATION,
    filterCheckInterval: FILTER_CHECK_INTERVAL,
    filterCheckDuration: FILTER_CHECK_DURATION,
    consecutiveMatchCount: CONSECUTIVE_FILTER_MATCHES,
    pumpFunBuyAmountSol: PUMP_FUN_BUY_AMOUNT_SOL,
    pumpFunMaxCurveProgress: PUMP_FUN_MAX_CURVE_PROGRESS,
    dryRun: DRY_RUN,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    maxDailyRaydiumBuys: MAX_DAILY_RAYDIUM_BUYS,
    maxDailyPumpFunBuySol: MAX_DAILY_PUMPFUN_BUY_SOL,
    trailingStop: TRAILING_STOP,
    trailingStopActivation: TRAILING_STOP_ACTIVATION,
    takeProfitSellPercent: TAKE_PROFIT_SELL_PERCENT,
    buyCooldownMs: BUY_COOLDOWN_MS,
    dynamicPriorityFee: DYNAMIC_PRIORITY_FEE,
    priorityFeeMultiplier: PRIORITY_FEE_MULTIPLIER,
    maxComputeUnitPrice: MAX_COMPUTE_UNIT_PRICE,
    simulateBeforeSend: SIMULATE_BEFORE_SEND,
    enableJupiterSell: ENABLE_JUPITER_SELL,
    enableJupiterCopyBuy: ENABLE_JUPITER_COPY_BUY,
  };

  const bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig, pumpFunCache, jupiter, breaker);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  const copyWallets = ENABLE_COPY_TRADE ? COPY_WALLETS.map((address) => new PublicKey(address)) : [];
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const listeners = new Listeners(connection);
  await listeners.start({
    walletPublicKey: wallet.publicKey,
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS,
    enableRaydium: ENABLE_RAYDIUM,
    enablePumpFun: ENABLE_PUMP_FUN,
    copyWallets,
  });

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), toMinimalMarket(marketState));
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
    const exists = await poolCache.get(poolState.baseMint.toString());

    if (!exists && poolOpenTime > runTimestamp) {
      poolCache.save(updatedAccountInfo.accountId.toString(), poolState);
      await bot.buy(updatedAccountInfo.accountId, poolState);
    }
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    if (bot.isPumpFunMint(accountData.mint.toString())) {
      await bot.sellPumpFun(updatedAccountInfo.accountId, accountData);
      return;
    }

    await bot.sell(updatedAccountInfo.accountId, accountData);
  });

  const copyBalances = new Map<string, bigint>();
  for (const copyWallet of copyWallets) {
    try {
      const existing = await connection.getTokenAccountsByOwner(copyWallet, { programId: TOKEN_PROGRAM_ID });
      for (const account of existing.value) {
        const data = AccountLayout.decode(account.account.data);
        copyBalances.set(account.pubkey.toString(), BigInt(data.amount.toString()));
      }
      logger.info({ wallet: copyWallet.toBase58(), accounts: existing.value.length }, 'Seeded copy-trade balances');
    } catch (error) {
      logger.warn({ wallet: copyWallet.toBase58(), error }, 'Failed to seed copy-trade balances');
    }
  }
  listeners.on('copy-trade', async (updatedAccountInfo: KeyedAccountInfo) => {
    try {
      const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);
      if (accountData.mint.equals(quoteToken.mint)) return;

      const key = updatedAccountInfo.accountId.toString();
      const next = BigInt(accountData.amount.toString());
      const previous = copyBalances.get(key) ?? 0n;
      copyBalances.set(key, next);

      if (next > previous) {
        logger.info(
          { mint: accountData.mint.toString(), source: updatedAccountInfo.accountId.toString() },
          'Copy wallet accumulated a token',
        );
        await bot.copyBuy(accountData.mint);
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to handle copy-trade event');
    }
  });

  listeners.on('pumpfun-create', async (logs: Logs) => {
    try {
      const tx = await connection.getTransaction(logs.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return;

      const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses,
      });
      const pumpPid = PUMP_FUN_PROGRAM_ID;
      const createIx = tx.transaction.message.compiledInstructions.find((ix) => {
        const pid = keys.get(ix.programIdIndex);
        return pid?.equals(pumpPid);
      });
      if (!createIx) return;

      const mintIdx = createIx.accountKeyIndexes[0];
      const mint = keys.get(mintIdx);
      if (!mint) return;

      logger.info({ mint: mint.toString(), sig: logs.signature }, 'Detected pump.fun token create');
      await bot.buyPumpFun(new PublicKey(mint.toString()));
    } catch (e) {
      logger.debug({ e }, 'Failed to handle pump.fun create');
    }
  });

  const arbitrage = new ArbitrageEngine(
    connection,
    wallet,
    jupiter,
    txExecutor,
    breaker,
    {
      enabled: ENABLE_ARBITRAGE,
      intervalMs: ARB_INTERVAL_MS,
      amountSol: ARB_AMOUNT_SOL,
      minProfitBps: ARB_MIN_PROFIT_BPS,
      maxDailySol: ARB_MAX_DAILY_SOL,
      slippageBps: ARB_SLIPPAGE_BPS,
      pairs: ARB_PAIRS,
      dexGroupA: ARB_DEX_GROUP_A,
      dexGroupB: ARB_DEX_GROUP_B,
      dryRun: DRY_RUN,
      simulateBeforeSend: SIMULATE_BEFORE_SEND,
      shouldSkip: () => bot.isBusy(),
    },
    CUSTOM_FEE,
  );
  arbitrage.start();

  setInterval(() => {
    logger.info(bot.snapshot(), 'Heartbeat');
  }, 60_000);

  printDetails(wallet, quoteToken, bot);
};

runListener();
