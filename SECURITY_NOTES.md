# Security notes (non-custodial safeguards)

This bot signs transactions **locally** with `PRIVATE_KEY` from your `.env`. There is no remote custody — whoever runs the process controls the funds. Treat the key like cash.

## Wallet hygiene

- Put `PRIVATE_KEY` only in a local `.env` (gitignored). Never commit it, paste it into issues/PRs, or share it in chat.
- Use a **dedicated trading wallet** with a small working balance — not your main cold wallet or NFT vault.
- Prefer hardware / multisig for long-term storage; fund the bot wallet as needed.
- Supported key formats: base58 secret key, JSON byte array, mnemonic, or 64/128-char hex (see `helpers/wallet.ts`).

## Live trading gate

- Default is **safe**: `LIVE_TRADING=false` forces dry-run even if `DRY_RUN=false`.
- Real broadcasts happen only when `LIVE_TRADING=true` **and** `DRY_RUN=false`.
- All Raydium / pump.fun / Jupiter / arbitrage send paths check this gate before `executeAndConfirm`.

Recommended `.env` for paper trading:

```
LIVE_TRADING=false
DRY_RUN=true
```

To go live (after you accept the risk):

```
LIVE_TRADING=true
DRY_RUN=false
```

## Warp / Jito tips

- `TRANSACTION_EXECUTOR=warp|jito` spends `CUSTOM_FEE` (SOL) as a tip/relay fee on **every** attempted send.
- Tips are paid even on failed landing; keep `CUSTOM_FEE` modest and prefer dry-run first.
- Tips do **not** bypass the live-trading gate.

## Holder / pool filters

- `CHECK_TOP_HOLDER` + `MAX_TOP_HOLDER_PERCENT` (`.env.copy` default **20**) reject concentrated non-LP wallets.
- Filters reduce — they do not eliminate — rug / honeypot risk. Simulation (`SIMULATE_BEFORE_SEND`) helps fail fast but is not a guarantee.

## Daily loss kill switch

- Tracks realized PnL vs a starting capital snapshot over a rolling 24h window (`MAX_DAILY_LOSS_PERCENT`, default 10).
- State persists in `.bot-state/daily-loss.json` so restarts do not wipe the counter.
- When tripped: **new buys are refused**. Sells may still run so you can exit.
- Resume: either delete/edit `.bot-state/daily-loss.json` to clear `tripped`, **or** set `RESET_KILL_SWITCH=true` once, restart, then set it back to `false`.

## Position size & pool age

- `MAX_POSITION_PERCENT` (default 2.5) caps each buy vs estimated quote capital (+ open exposure).
- `MIN_POOL_AGE_SECONDS` (default 30) waits/rejects pools younger than the threshold (`poolOpenTime` vs now).

## Audit log

- Structured decisions append to `logs/decisions.jsonl` (`enter` / `exit` / `skip` with reason, size, dryRun/live, pnl).
- Both `logs/` and `.bot-state/` are gitignored.

## Remaining risks (not fully mitigated)

- Smart-contract / pool malice, oracle manipulation, RPC lying or censoring, MEV sandwiching.
- Private key malware on the host running the bot.
- Misconfiguration (`LIVE_TRADING=true` with a funded wallet).
- Circuit breaker is **failure-count** based, not PnL-based (PnL is the kill switch).
- Unrealized mark-to-market is not fully priced; kill switch is primarily realized-PnL driven.
