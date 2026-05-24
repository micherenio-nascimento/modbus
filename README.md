# DSE 855 SCADA

Stack Docker com coletor Node.js para coletar dados do DSE 855 a cada 1 segundo, exibir no Grafana com refresh de 1 segundo e salvar snapshots no MySQL a cada 5 minutos.

## Autenticacao

O endpoint retorna um `SID`, mas o tempo exato de validade da sessao nao aparece na resposta enviada. Por isso o coletor nao assume um TTL fixo: ele reutiliza o `SID` enquanto funcionar e refaz o login automaticamente se o `realtime.cgi` rejeitar a sessao ou voltar sem dados MODBUS.

Se voce descobrir empiricamente um TTL, defina `SESSION_REFRESH_SECONDS` no `.env`. Com o valor padrao `0`, o coletor so renova quando necessario.

## Como executar

```bash
cp .env.example .env
docker compose up -d --build
```

Servicos:

- Grafana: http://localhost:3000
- Prometheus: http://localhost:9090
- Metricas do coletor: http://localhost:9108/metrics
- MySQL: localhost:3306

Login padrao do Grafana, se nao alterar o `.env`:

- Usuario: `admin`
- Senha: `admin`

## Banco de dados

A tabela `dse_readings` recebe uma linha a cada 300 segundos por padrao. Ajuste em:

```env
MYSQL_SAVE_INTERVAL_SECONDS=300
```

Consulta rapida:

```bash
docker compose exec mysql mysql -u dse -pdse_password dse855 -e "SELECT collected_at, frequency_hz, mains_l1_v, mains_l2_v, mains_l3_v, battery_v, engine_hours_text FROM dse_readings ORDER BY collected_at DESC LIMIT 10;"
```

## Registradores mapeados

- `5 / 10`: bateria do motor em V
- `22 / 10`: frequencia em Hz
- `23..25 / 10`: tensoes L1/L2/L3 em V
- `26..28 / 10`: tensoes L1-L2/L2-L3/L3-L1 em V
- `306 / 10`: kWh acumulado
- `308 / 10`: kVAh acumulado
- `309 / 10`: kVArh acumulado
- `310`: partidas do motor
- `305`: horas do motor em segundos, salvo tambem em texto `150h 46m`

Valores `2147483647` e `2147483645` sao ignorados nas metricas e gravados como `NULL` nos campos parseados.
