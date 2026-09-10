# Netlify deployment — Index Options Mentor v0.8

This version keeps the browser UI on Netlify and moves the FYERS server routes into a Netlify Function.

## Why v0.7 cannot simply be drag-dropped

v0.7 runs an Express server on `127.0.0.1:8787` and stores the FYERS access token in server memory. Netlify serves the Vite frontend statically and Functions run in ephemeral serverless runtimes, so that in-memory token design is not reliable on Netlify.

v0.8 fixes this by storing the FYERS access token in an encrypted, HttpOnly, same-origin browser cookie. The FYERS App Secret and session-encryption secret remain server-side in Netlify environment variables.

## First deploy

Recommended: push the project to a private GitHub repository and connect the repository to Netlify.

Netlify should detect the included `netlify.toml`:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

After the first deploy, note the production URL, for example:

`https://your-site-name.netlify.app`

## Update FYERS

In FYERS API Dashboard > Index Options Mentor > Edit, change the Redirect URL from the localhost callback to:

`https://your-site-name.netlify.app/api/fyers/callback`

Use the exact deployed hostname and HTTPS.

## Netlify environment variables

In Netlify Project configuration > Environment variables, add:

- `FYERS_APP_ID` = your FYERS App ID
- `FYERS_APP_SECRET` = your FYERS Secret ID
- `FYERS_SESSION_SECRET` = a long random value used only to encrypt the login cookie

Generate a session secret on macOS with:

`openssl rand -hex 32`

Do not use a `VITE_` prefix for any secret.

`FYERS_REDIRECT_URI` is optional in production because the function derives the callback from the deployed site URL. You may set it explicitly if desired.

After adding/changing environment variables, trigger a new production deploy.

## Test

Open:

`https://your-site-name.netlify.app/api/fyers/status`

Expected before login:

`{"configured":true,"authenticated":false,...}`

Then open the main site and press `Connect FYERS`.

After FYERS sends you back, `/api/fyers/status` should show `authenticated:true` and the dashboard should populate.

## Security

- Never upload `.env` to GitHub or Netlify Deploys.
- Never put FYERS App Secret or session secret in frontend code.
- The generated session cookie is encrypted, HttpOnly, SameSite=Lax and Secure on HTTPS.
- The dashboard remains non-trading: no real broker order placement is implemented.

## Current live-data model

The deployed version continues polling:

- full mentor snapshot every 15 seconds
- exact option + NIFTY quote every 5 seconds while a simulated position is open

The old local WebSocket/SSE server route is not used by the current UI and is not required for the Netlify deployment.
