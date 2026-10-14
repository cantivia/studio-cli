# Studio connection service

A small Cloudflare Worker that gives each Mac app its own private address (`studio-<words>.cantivia.com`) and the tunnel behind it, when someone presses **Turn on phone access**. It runs on the Cloudflare account that owns the domain. **Nothing here is deployed yet.**

What it does and doesn't do:
- It creates a tunnel and a DNS record, and hands the tunnel token back to the app that asked. It never sees terminals or traffic; those go phone → Cloudflare → that person's own computer, where a paired-device cookie is required.
- An app proves itself with a random 256-bit install id kept on that computer. Only its hash is stored here, so only that computer can fetch its token again or give the address back.
- Limits: 3 new setups per network per day, 300 new setups per day overall, and addresses unused (and offline) for 180 days are removed daily.
- No emails, accounts or personal data are stored.

## Deploy (one time, about 10 minutes)

```bash
cd provisioner
npx wrangler login
npx wrangler kv namespace create REG          # copy the id into wrangler.toml
# put your account id and the zone id for cantivia.com into wrangler.toml ([vars] CF_ACCOUNT_ID, CF_ZONE_ID)
npx wrangler secret put CF_API_TOKEN          # token: Account · Cloudflare Tunnel · Edit  +  Zone · DNS · Edit (only the cantivia.com zone)
npx wrangler deploy
curl https://studio-api.cantivia.com/v1/health   # → {"ok":true}
```

`wrangler.toml` serves it on `studio-api.cantivia.com`; change `routes` if you prefer another address, and set the same address in the app (`STUDIO_PROVISIONER`, default `https://studio-api.cantivia.com`, see `server/provision.ts`).

Test it without Cloudflare: `node provisioner/worker.test.mjs`.

To stop new sign-ups instantly, set `MAX_PER_DAY` to `0` in `wrangler.toml` and deploy. Existing installs keep working.
