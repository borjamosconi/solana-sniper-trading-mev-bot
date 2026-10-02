# Arquitectura del módulo de backtesting (solo lectura / simulación)

## Qué valida (y qué no)

**Útil para:** stop-loss, take-profit, trailing, tamaño de posición (%), filtros que se pueden aplicar *después* de tener precio/liquidez en el tiempo.

**Débil o engañoso para:** sniping al milisegundo, copy-trade de KOLs (hace falta el timestamp real de su compra), scoring Pump/GMGN en t=0 si no guardaste ese snapshot histórico, slippage, fallos RPC, MEV y competencia.

Por eso el motor de backtest **reutiliza reglas de salida y sizing**, pero modela la **entrada** como un evento configurable (`entry_at` = creación del pool, o primer cruce de score, o “KOL bought at T”) — no finge ser Jupiter en mainnet.

## Capas (separadas del live)

```
backtest/
  data/                  # parquet/jsonl OHLCV por mint/pair (gitignored dumps grandes)
  fetch_ohlcv.ts         # descarga histórica (GeckoTerminal; Birdeye opcional)
  types.ts               # Candle, Trade, SimConfig, SimResult
  strategy_adapter.ts    # adapta la MISMA config (TP/SL/%) que helpers/constants / exit-strategy
  engine.ts              # recorre velas, abre/cierra, equity curve
  metrics.ts             # win rate, profit factor, max DD, etc.
  store_sqlite.ts        # guarda runs + config JSON + métricas
  report.ts              # HTML + Chart.js curva de capital + disclaimer fijo
  cli.ts                 # npx ts-node backtest/cli.ts --mint ... --config ...
```

El bot live (`bot.ts`, Jupiter, listeners) **no importa** el backtest. El backtest **sí importa** (o duplica de forma controlada) la lógica pura de reglas desde `helpers/exit-strategy.ts` y los % de env — sin `Connection` ni firma.

## Flujo

1. **Fetch** → OHLCV 1m/5m desde creación (o desde `from`/`to`) → `data/{mint}.jsonl`
2. **Sim** → capital inicial, `MAX_POSITION_PERCENT`, TP/SL/trailing; entrada en vela `entryIndex` (regla documentada)
3. **Metrics** → resumen + serie equity
4. **SQLite** → tabla `runs(id, created_at, config_json, metrics_json, equity_path)`
5. **Report** → HTML con disclaimer obligatorio

## Datos: DexScreener vs realidad

La API pública de DexScreener **no ofrece velas OHLCV**. Para histórico usamos **GeckoTerminal** (público) o **Birdeye** (API key). DexScreener sirve para descubrir `pairAddress` / liquidez *actual*, no para backtest candle-by-candle.

## Disclaimer (siempre en el reporte)

> El rendimiento pasado no garantiza resultados futuros. Este backtest no captura slippage real, fallos de red, MEV ni competencia de bots más rápidos.
