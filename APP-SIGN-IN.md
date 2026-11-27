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
Nothing here is approved yet. Each live step needs the owner's separate approval. Install outside market hours with no trade open.

1. In Netlify production, set the four sign-in values above. Also confirm production has the settings the previews used: `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_SESSION_SECRET`, `AWS_PAPER_SYNC_BASE`, `AWS_PAPER_SYNC_SECRET`, `JOURNAL_WEB_APP_URL`, `JOURNAL_SHARED_SECRET`. Their live values have not been checked.
2. Set `FYERS_REDIRECT_URI`, and the same address in the FYERS app, to `https://optionsmentor.netlify.app/api/fyers/callback`.
3. Install the web functions on the main address first, then the AWS order host straight after. The AWS setup files now send their signed check to the main address, so it passes only once the new web functions are there. The new Buy needs both.
4. Use the rebuilt `public/iom-order-host.py` from the approved commit. It refuses to replace an enabled host, or one whose records show an unfinished order or a held trade. When it does replace a host, it removes any operator approval, so the new host cannot send any order.
5. Close old copies. GitHub Pages, old Netlify previews and old deploys keep the old, unprotected code. Their functions may still hold working keys.
   - Remove or disable them.
   - Limit secrets to production.
   - Replace the keys they could use (FYERS session and app secrets, the AWS bridge key, the journal keys). Update AWS at the same time.
   - `src/AppV3.jsx` runs the AWS cross-check on practice exits only on preview 28. It is already off on the main address and is unchanged here. Decide whether it is wanted before removing that preview.
6. With real money off, check on the actual phone: Google sign-in (also from the home-screen app), FYERS connect, sign out all devices, and refusal when signed out. Check that the journal health address and the journal itself are both refused when signed out.
7. Check Netlify usage limits: while Settings is open with buying on, the app asks the server about every 3 seconds.

## Switching back
- The order database keeps its earlier tables' columns, so the earlier version can still write to them. This was tried with the code from before the order-safety work on a database created by the new code, covering the stop-action and entry-cancel writes only.
- This does not prove a full switch-back. The version installed on AWS has not been checked, and the earlier version does not understand trades recorded as sold outside the app.
- If the setup fails, it restores its service and route settings. It does not restore the database.
- Switching the web back also switches the sign-in protection off.

## Not covered
- Real Google sign-in, real Netlify and a real phone are untested.
- Practice data already saved on a device stays there after sign-out. App program files can still be downloaded.
- Signing out does not stop automatic buying on the server.
- Journal and order control still share one server key.
