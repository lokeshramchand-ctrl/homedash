# Browser smoke tests

They open the built UI in a real browser, sign in and visit every page, failing on script errors.

```sh
npm run build                         # builds dist/
# start the backend with SERVE_DIST pointing at dist/, and a user: npm run create-user -- admin admin
E2E_PASS='<password>' E2E_URL=http://127.0.0.1:3000 npm run e2e
# E2E_CHANNEL=chrome uses the installed Chrome; otherwise run `npx playwright install chromium` once.
# E2E_SHOTS=<dir> saves a screenshot of every page.
```
Without `E2E_PASS` the tests are skipped.
