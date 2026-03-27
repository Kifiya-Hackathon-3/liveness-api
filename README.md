# Liveness Check UI (Go)

This app serves the liveness-check web UI with a Go server and supports mobile deep-link callbacks.

## Run

```bash
go run .
```

Default URL: `http://127.0.0.1:5501/` (or `http://localhost:5501/`)

On startup the process logs **LAN URLs** as well. **Remote SSH:** forward port **5501** in the editor **Ports** tab, then open that URL in Chrome/Firefox. **CDN:** the UI loads MediaPipe from **esm.sh** / **jsdelivr** / **Google storage**; strict blocking can look “stuck” (DevTools → Network).

### HTTPS / camera on LAN (Chromium)

**Yes, it can be an HTTPS issue.** Browsers treat `http://127.0.0.1` and `http://localhost` as a **secure context** for the camera, but **`http://192.168.x.x` (plain HTTP on your LAN) is not**, so `getUserMedia` often fails on a **phone** or **another PC** using your Wi‑Fi IP.

**Options:**

1. **Loopback only (no TLS):** use `http://127.0.0.1:5501/` on the same machine.
2. **HTTPS with local certs (recommended for real devices on Wi‑Fi):** set **`TLS_CERT_FILE`** and **`TLS_KEY_FILE`** so the server uses `ListenAndServeTLS`.

   With [mkcert](https://github.com/FiloSottile/mkcert) (after `mkcert -install` on your dev machine):

   ```bash
   mkdir -p certs
   # Replace 192.168.1.42 with the LAN IPv4 printed when you start the server.
   mkcert -cert-file certs/liveness.pem -key-file certs/liveness-key.pem \
     localhost 127.0.0.1 ::1 192.168.1.42

   TLS_CERT_FILE=certs/liveness.pem TLS_KEY_FILE=certs/liveness-key.pem go run .
   ```

   Open `https://192.168.1.42:5501/` on the phone. **Trust:** install mkcert’s root CA on the device if prompted (from `mkcert -CAROOT`, copy `rootCA.pem`; iOS/Android each have a “install profile / CA” flow), or the browser will warn about the certificate.

3. **Tunnel:** [ngrok](https://ngrok.com/), Cloudflare Tunnel, etc. give real `https://` without LAN certs; point the tunnel at `localhost:5501`.

**Mixed content:** if the UI is `https://…:5501` but `API_BASE` is `http://…`, some browsers block API calls from the page. Prefer `https` for the API as well, same host with a reverse proxy, or `http://127.0.0.1:8080` for the API when the page is also served from loopback.

**Env:** `LISTEN_ADDR` (default `:"+PORT"` all addresses), `PORT` (default `5501`), `TLS_CERT_FILE`, `TLS_KEY_FILE` (both required to enable TLS).

## Runtime Config

The UI reads config from `/config.js` (served by Go). Values come from query params first, then env vars.

- `api_base` / `API_BASE` (default `http://localhost:8080`)
- `subject_id` / `SUBJECT_ID` (default `sub_demo`)
- `api_token` / `API_TOKEN` (default `dummy.jwt.token`)
- `success_redirect` / `SUCCESS_REDIRECT` (optional)
- `fail_redirect` / `FAIL_REDIRECT` (optional)
- `app_scheme` / `APP_SCHEME` (optional, e.g. `myapp`)
- `app_deep_link_path` / `APP_DEEP_LINK_PATH` (default `liveness/result`; used with `app_scheme` when success/fail URLs are not set)
- `android_package` / `ANDROID_PACKAGE` (optional Android applicationId; enables `intent://…#Intent;scheme=…;package=…` navigation for custom schemes)
- `navigate_on_result` / `NAVIGATE_ON_RESULT` (default `true`; set `false` to only use JS bridges and skip `location.assign`, e.g. some embedded WebViews)
- `state` / `STATE` (optional correlation value)
- `embedded` / `EMBEDDED` (`true` for mobile WebView layout)
- `autostart` / `AUTOSTART` (`true` to auto-trigger start)

## Mobile Deep Linking

When liveness finishes:
- pass => redirect to `success_redirect` (or `app_scheme://{app_deep_link_path}`)
- fail => redirect to `fail_redirect` (or same scheme URL as pass)

On Android, if `android_package` is set, custom-scheme targets are opened via an **intent URL** first (more reliable in Chrome/system WebView than a raw `myapp://` navigation).

Query params appended:
- `status` (`PASSED` or `FAILED`)
- `score`
- `session_id`
- `subject_id`
- `state`
- `message`

## Embedded Mobile WebView

When `embedded=true`, UI switches to compact full-height layout for in-app embedding:
- hides header/footer
- applies safe-area padding
- optimizes camera area for portrait mobile

Result callbacks are posted to available bridges:
- `window.ReactNativeWebView.postMessage(JSON.stringify(payload))`
- `window.flutter_inappwebview.callHandler("livenessResult", payload)`
- `window.webkit.messageHandlers.livenessResult.postMessage(payload)` (iOS WKWebView)
- `window.parent.postMessage(payload, "*")`

Payload:
- `type` (`LIVENESS_RESULT`)
- `status`, `score`, `session_id`, `subject_id`, `state`, `message`

Important camera requirements:
- Origin must be secure (`https`) or `localhost`.
- In mobile WebView, host app must explicitly grant camera permission to the web content.
- If using Android emulator, verify virtual camera is enabled.

## Example Integration URL

```text
http://localhost:5501/?api_base=http://localhost:8080&subject_id=sub_123&api_token=<jwt>&embedded=true&autostart=true&success_redirect=myapp://kyc/liveness/success&fail_redirect=myapp://kyc/liveness/fail&android_package=com.example.wallet&state=req_789
```
