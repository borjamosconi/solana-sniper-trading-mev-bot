# Arranque dry-run (48–72 h)

Simula copy-trade del top 10 Kolscan **sin** mandar transacciones reales.
Rama: `safeguards/risk-controls`.

## 1. Clonar / actualizar

```bash
git clone https://github.com/borjamosconi/solana-sniper-trading-mev-bot.git
cd solana-sniper-trading-mev-bot
git fetch origin
git checkout safeguards/risk-controls
git pull
```

## 2. Instalar

```bash
npm install
npm run tsc
```

## 3. Crear `.env`

```bash
cp .env.dry-run.example .env
```

Edita `.env` y rellena solo esto:

| Variable | Qué poner |
|----------|-----------|
| `PRIVATE_KEY` | Clave base58 de una **wallet dedicada** (Phantom → Export Private Key). Nunca la principal. |
| `RPC_ENDPOINT` | HTTPS de Helius / QuickNode / similar (no el RPC público). |
| `RPC_WEBSOCKET_ENDPOINT` | WSS del mismo proveedor. |
| `TELEGRAM_BOT_TOKEN` | Token de `@tradingmemesgrok_bot` (BotFather). |
| `TELEGRAM_CHAT_ID` | Tu chat id (ya conocido si hiciste `/start`). |

Deja así:

- `LIVE_TRADING=false`
- `DRY_RUN=true`
- `ENABLE_COPY_TRADE=true`
- `ENABLE_RAYDIUM=false` / `ENABLE_PUMP_FUN=false` (este perfil valida copy-trade primero)

## 4. Fondos mínimos (opcional pero útil)

Aunque no compre en dry-run, conviene que la wallet tenga un poco de **SOL** (fees / ATA) y **WSOL** por si pasas a live después. En dry-run no se gasta en swaps.

## 5. Arrancar

```bash
npm start
```

Deberías ver en logs: dry-run mode, copy trade wallets=10, Telegram enabled.
En Telegram: mensajes `🟢 ENTER` / `⏭️ SKIP` / `🔴 EXIT` con etiqueta **`[DRY]`**.

## 6. Qué mirar 2–3 días

- `logs/decisions.jsonl` — volumen de señales, motivos de skip
- Telegram — ¿demasiado ruido? ¿wallets correctas?
- Errores de RPC / websocket

Si la lista Kolscan cambia (día 1 de mes), reinicia el bot tras actualizar `COPY_WALLETS`.

## 7. Parar

`Ctrl+C`

## 8. Solo cuando el dry-run tenga sentido → live controlado

```env
LIVE_TRADING=true
DRY_RUN=false
QUOTE_AMOUNT=0.001
```

Reinicia. Empieza con capital que puedas perder. Mantén kill switch y `MAX_POSITION_PERCENT=2.5`.


## 9. Panel informativo (solo lectura)

Mientras el bot corre (`npm start`), en otra terminal:

```bash
npm run dashboard
```

Abre **http://127.0.0.1:8787** (solo localhost). Puerto opcional: `DASHBOARD_PORT=8790 npm run dashboard`.

El panel muestra modo DRY/LIVE, kill switch, feed de `logs/decisions.jsonl` y el top 10 Kolscan. **No permite operar** ni cambiar configuración (solo GET).

## Seguridad

- No subas `.env` a GitHub (ya está en `.gitignore`).
- No pegues `PRIVATE_KEY` en chats.
- Ver `SECURITY_NOTES.md`.

## 9. Ver el rendimiento en papel (dashboard "control room", solo lectura)

```bash
npm run dashboard            # http://127.0.0.1:8787/paper  (JSON: /api/paper)
npm run dashboard:snapshot   # HTML estático autocontenido → dashboard/snapshots/paper-<fecha>.html
```

- Panel principal: <http://127.0.0.1:8787> · **Control room papel:** <http://127.0.0.1:8787/paper>
- Solo GET: sin botones de trading, sin POST. Se refresca cada 60 s ("ACT." + cuenta atrás).
- El snapshot lleva los datos embebidos y gráficos SVG inline: se abre sin conexión y se puede enviar
  (la carpeta `dashboard/snapshots/` está en `.gitignore`).

Qué muestra (todo calculado de `logs/decisions.jsonl` + precios públicos, nada inventado):

- **Cabecera:** modo PAPER/LIVE según `LIVE_TRADING` (solo se lee el booleano), estado del kill switch
  (`.bot-state/daily-loss.json`), última actualización y la píldora DRY-RUN.
- **Ticker:** tokens con precio DexScreener, variación 24 h y PnL papel.
- **Position radar:** una tarjeta por posición (PnL %, velas, barra SL→TP con la posición del precio).
  Filtros abierta/cerrada/fuente. Clic = gráfico grande con líneas de entrada/TP/SL.
- **Control room:** diagrama PROMESA / Kolscan / Filtros / Riesgo / Ejecutor Jupiter → CORE con conteos
  reales (handoffs, entradas, skips, TP/SL, fills en papel) + KPIs (win rate, profit factor, PnL total,
  máx. drawdown).
- **Telemetría:** exposición (SOL desplegado / bankroll), barras por actor, curva de equity, volumen 24 h
  y *decision tape* (ENTER/SKIP/HOLD/EXIT).

Reglas de la simulación:

- Cada `DRY_RUN_ENTER` abre una posición en papel (hora = `ts`). Un `ENTER` repetido del mismo mint con la
  posición abierta **no añade tamaño** (HOLD). Si la posición ya se cerró por TP/SL, un nuevo ENTER abre otra.
  También entiende el formato antiguo del bot (`side: enter|exit|skip`).
- **Precio de entrada:** apertura de la vela OHLCV más fina que contiene `ts`. Fuentes, por orden:
  1. importaciones locales: `backtest/data/<mint>-<N>m.jsonl` (de `npm run backtest:fetch -- --mint <MINT> --aggregate 15`)
     y `.bot-state/paper-ohlcv-import/<mint>.json`;
  2. GeckoTerminal (sin clave; pool de DexScreener y, si falla, el pool principal de GeckoTerminal);
  3. CoinGecko on-chain si defines `COINGECKO_API_KEY` (clave demo gratuita; `COINGECKO_API_PLAN=pro` si es de pago);
  4. Birdeye si defines `BIRDEYE_API_KEY`.
  Si nada responde, se usa el primer precio DexScreener observado y se marca **ENTRY APPROX**; esas posiciones
  se muestran pero **no cuentan en los KPIs**. Axiom no tiene API pública documentada de precios → no soportado.
- **Precio actual:** DexScreener (`/latest/dex/tokens/<mint>`, par con más liquidez), caché ~60 s, pausa si 429.
- **Salidas:** `TAKE_PROFIT` / `STOP_LOSS` (%) de `process.env` → `.env` → `.env.copy` (repo: TP +40 %, SL −20 %;
  si faltan, +100 % / −30 %). SL se evalúa antes que TP; si hay un hueco sin velas, el TP se llena al nivel TP.
  No se aplica el timeout `PRICE_CHECK_DURATION`.
- **Tamaño:** `max_position_percent` (2,5 %) de `PAPER_BANKROLL_SOL` (por defecto 1 SOL).
- Cachés en `.bot-state/` (gitignored). Bórralas para recalcular desde cero.

⚠️ Simulación: rentabilidades pasadas no garantizan resultados futuros. No incluye slippage, comisiones, MEV
ni la liquidez real para salir.
