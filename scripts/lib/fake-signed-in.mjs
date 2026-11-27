// Screen tests only: a fake server reply saying today's sign-in is valid. Register
// after the catch-all API route so that it takes priority.
export const fakeSignedIn = page => page.route('**/api/auth/session', route => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ signedIn: true, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
}));
