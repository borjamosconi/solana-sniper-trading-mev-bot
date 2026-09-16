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
