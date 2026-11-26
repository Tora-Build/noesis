# Sooth Hedge bot on a VPS

One systemd service runs `agent/bot.mjs`. It has three jobs:

- Settler, every 60 s. It settles every market of our adjudicator after its deadline.
- Agent, every 15 min. It analyzes each open market and trades under a daily cap.
- Creator, once a day at 21:05 UTC. It makes 3 close-below markets each for IWMB, EWZB and BNB with the next weekday 21:00 UTC deadline.

When `BOT_PUBLISH=1`, it publishes the page to Cloudflare Pages (project `noesis`) after it adds markets. After trades it publishes at most once per hour.

The bot wallet is an allowed creator, not the node admin. It needs BNB for gas and hUSD-DEMO for funding (2,500 per market at most, so about 22,500 per day for 9 markets, plus trades).

## Needs

- Node 22 and git. No Foundry.
- A read-only deploy key for the repo.
- The node admin calls `MarketFactory.setCreatorAllowed(<bot address>, true)` once.

## Install

Run these as user `zak`.

```sh
# 1. Clone with the deploy key.
GIT_SSH_COMMAND='ssh -i ~/.ssh/sooth_hedge_deploy -o IdentitiesOnly=yes' \
  git clone -b develop git@github.com:<owner>/sooth-hedge.git ~/sooth-hedge
cd ~/sooth-hedge
git config core.sshCommand 'ssh -i ~/.ssh/sooth_hedge_deploy -o IdentitiesOnly=yes'

# 2. Install packages (repo root for the page build, agent/ for the bot).
npm ci
(cd agent && npm ci && npm test)

# 3. Env file. Fill in the values. Keep it private.
cp agent/bot.env.example ~/sooth-hedge.env
chmod 600 ~/sooth-hedge.env
nano ~/sooth-hedge.env
```

Set at least `BOT_PRIVATE_KEY`, `BSC_RPC_URL` and `CMC_API_KEY`. For the page set `BOT_PUBLISH=1`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Start with `BOT_DRY_RUN=1`. Read the log. Then set `BOT_DRY_RUN=0` and restart.

## Enable the service

```sh
sudo cp ~/sooth-hedge/deploy/sooth-hedge-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sooth-hedge-bot
systemctl status sooth-hedge-bot
```

## Logs

Each action is one JSON line.

```sh
tail -f ~/sooth-hedge-bot.log
grep '"level":"error"' ~/sooth-hedge-bot.log | tail
grep '"job":"create"' ~/sooth-hedge-bot.log | tail
```

The state file is `~/sooth-hedge/agent/bot-state.json`. It holds the known markets, the spend per day and the last run times. Do not delete it while the bot runs. If you delete it, the bot scans the chain again. It does not create a market twice, because it checks the MarketCreated events first.

## Update

```sh
cd ~/sooth-hedge && git pull && npm ci && (cd agent && npm ci)
sudo systemctl restart sooth-hedge-bot
```

## Stop and remove

```sh
sudo systemctl disable --now sooth-hedge-bot
sudo rm /etc/systemd/system/sooth-hedge-bot.service
sudo systemctl daemon-reload
```

To remove everything, also delete `~/sooth-hedge`, `~/sooth-hedge.env` and `~/sooth-hedge-bot.log`. The node admin can call `setCreatorAllowed(<bot address>, false)`.

## Notes

- US market holidays: put the dates in `BOT_SKIP_DATES` (for example `2026-12-25`). On a half day the stock feeds can stop before 21:00 UTC. Then a close market reads too late and settles INVALID.
- In US summer time the close is 20:00 UTC. Set `DEADLINE_AT_UTC=20:00` and `CREATE_AT_UTC=20:05`.
- SIGTERM (systemctl stop) lets the current job finish, saves the state and exits.
