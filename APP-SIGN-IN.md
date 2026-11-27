# App sign-in and one-tap buy: before installing

Built and tested with fake accounts, a fake server and a fake broker only. Not installed.

## What it does
- Sign in with Google for one approved account. A sign-in ends at the next midnight, India time.
- Every private page and server route needs that sign-in, on `https://optionsmentor.netlify.app` only.
- "Sign out all devices" ends every sign-in. If that record cannot be read, everything stays locked, including app Exit. Use the FYERS app then.
- The server's own signed maintenance routes do not use the app sign-in.
- One tap buys. The server refuses a higher price, or a different option or quantity, than the screen showed.

## Server settings (Netlify, production only)
| Name | Value |
|---|---|
| `APP_GOOGLE_CLIENT_ID` | Web client ID from Google Cloud. Authorised JavaScript origin: the main address. Not a secret. |
| `APP_ALLOWED_GOOGLE_EMAIL` | The one personal Gmail address. |
| `APP_ALLOWED_GOOGLE_SUB` | Optional permanent Google ID. When set, it alone decides. Needed for a non-Gmail account. |
| `APP_SESSION_SECRET` | New random value, 32 characters or more, used for nothing else. |

Never put these values in the code or a chat.

## Install checklist
1. Set `FYERS_REDIRECT_URI`, and the same address in the FYERS app, to `https://optionsmentor.netlify.app/api/fyers/callback`.
2. Install the web functions and the AWS order host together: the new Buy needs both. Rebuild and check the order-host installer first; it has not been rebuilt for these changes.
3. Close old copies. GitHub Pages, old Netlify previews and old deploys keep the old, unprotected code. Their functions may still hold working keys.
   - Remove or disable them.
   - Limit secrets to production.
   - Replace the keys they could use (FYERS session and app secrets, the AWS bridge key, the journal keys). Update AWS at the same time.
4. Server maintenance scripts still name a preview address (`aws/readiness/release_check.py`, `scripts/order-host-template.py`, `scripts/execution-connect-template.py`). Point them at the main address before removing previews.
   - `src/AppV3.jsx` runs the AWS cross-check on practice exits only on preview 28. It is already off on the main address and is unchanged here. Decide whether it is wanted before removing that preview.
5. With real money off, check on the actual phone: Google sign-in (also from the home-screen app), FYERS connect, sign out all devices, and refusal when signed out.
6. Check Netlify usage limits: while Settings is open with buying on, the app asks the server about every 3 seconds.

## Not covered
- Real Google sign-in, real Netlify and a real phone are untested.
- Practice data already saved on a device stays there after sign-out. App program files can still be downloaded.
- Signing out does not stop automatic buying on the server.
- Journal and order control still share one server key.
