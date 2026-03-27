package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// Static UI files are embedded so the server works no matter which directory you run it from.
//
//go:embed index.html styles.css liveness.js
var staticFS embed.FS

type runtimeConfig struct {
	APIBase          string `json:"apiBase"`
	SubjectID        string `json:"subjectId"`
	APIToken         string `json:"apiToken"`
	SuccessRedirect  string `json:"successRedirect"`
	FailRedirect     string `json:"failRedirect"`
	AppScheme        string `json:"appScheme"`
	AppDeepLinkPath  string `json:"appDeepLinkPath"`
	AndroidPackage   string `json:"androidPackage"`
	NavigateOnResult bool   `json:"navigateOnResult"`
	State            string `json:"state"`
	Embedded         bool   `json:"embedded"`
	AutoStart        bool   `json:"autoStart"`
}

func main() {
	port := envOrDefault("PORT", "5501")
	// Default all local addresses (IPv4 + IPv6). Use LISTEN_ADDR=0.0.0.0:5501 or 127.0.0.1:5501 when needed.
	addr := envOrDefault("LISTEN_ADDR", ":"+port)
	certFile := strings.TrimSpace(os.Getenv("TLS_CERT_FILE"))
	keyFile := strings.TrimSpace(os.Getenv("TLS_KEY_FILE"))

	mux := http.NewServeMux()
	attachCDNProxies(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/config.js", serveConfigJS)
	mux.HandleFunc("/styles.css", serveEmbedded("styles.css", "text/css; charset=utf-8"))
	mux.HandleFunc("/liveness.js", serveEmbedded("liveness.js", "application/javascript; charset=utf-8"))
	mux.HandleFunc("/", serveIndex)

	scheme := "http"
	var serveErr error
	if certFile != "" && keyFile != "" {
		scheme = "https"
		log.Printf("liveness-check UI listening with TLS on %s", addr)
		logAccessURLs(port, scheme)
		serveErr = http.ListenAndServeTLS(addr, certFile, keyFile, mux)
	} else {
		if certFile != "" || keyFile != "" {
			log.Fatal("TLS: set both TLS_CERT_FILE and TLS_KEY_FILE, or omit both for plain HTTP")
		}
		log.Printf("liveness-check UI listening on %s (HTTP — camera may be blocked on LAN IPs; use HTTPS or 127.0.0.1)", addr)
		logAccessURLs(port, scheme)
		serveErr = http.ListenAndServe(addr, mux)
	}
	if serveErr != nil {
		log.Fatal(serveErr)
	}
}

func logAccessURLs(port, scheme string) {
	log.Printf("open in your system browser: %s://127.0.0.1:%s/", scheme, port)
	if ifaces, err := net.InterfaceAddrs(); err == nil {
		seen := map[string]bool{}
		for _, a := range ifaces {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() {
				continue
			}
			v4 := ipnet.IP.To4()
			if v4 == nil {
				continue
			}
			s := v4.String()
			if seen[s] {
				continue
			}
			seen[s] = true
			log.Printf("  LAN / phone: %s://%s:%s/", scheme, s, port)
		}
	}
	if scheme == "http" {
		log.Printf("tip: Chromium blocks camera on http://<LAN-IP> (not a secure context). Use https:// with TLS_CERT_FILE/TLS_KEY_FILE (see README) or open via http://127.0.0.1:%s/ only.", port)
	}
	log.Printf("Remote-SSH: forward port %s, then open the forwarded %s://127.0.0.1:… URL in your system browser.", port, scheme)
}

func serveEmbedded(name, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+name {
			http.NotFound(w, r)
			return
		}
		b, err := staticFS.ReadFile(name)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(b)
	}
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	b, err := staticFS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "index not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

func serveConfigJS(w http.ResponseWriter, r *http.Request) {
	nav := queryOrEnv(r, "navigate_on_result", "NAVIGATE_ON_RESULT", "true")
	cfg := runtimeConfig{
		APIBase:          queryOrEnv(r, "api_base", "API_BASE", "http://localhost:8080"),
		SubjectID:        queryOrEnv(r, "subject_id", "SUBJECT_ID", "sub_demo"),
		APIToken:         queryOrEnv(r, "api_token", "API_TOKEN", "dummy.jwt.token"),
		SuccessRedirect:  queryOrEnv(r, "success_redirect", "SUCCESS_REDIRECT", ""),
		FailRedirect:     queryOrEnv(r, "fail_redirect", "FAIL_REDIRECT", ""),
		AppScheme:        queryOrEnv(r, "app_scheme", "APP_SCHEME", ""),
		AppDeepLinkPath:  queryOrEnv(r, "app_deep_link_path", "APP_DEEP_LINK_PATH", "liveness/result"),
		AndroidPackage:   queryOrEnv(r, "android_package", "ANDROID_PACKAGE", ""),
		NavigateOnResult: nav != "false" && nav != "0",
		State:            queryOrEnv(r, "state", "STATE", ""),
		Embedded:         queryOrEnv(r, "embedded", "EMBEDDED", "false") == "true",
		AutoStart:        queryOrEnv(r, "autostart", "AUTOSTART", "false") == "true",
	}

	js, err := json.Marshal(cfg)
	if err != nil {
		http.Error(w, "failed to render config", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	_, _ = fmt.Fprintf(w, "window.LIVENESS_CONFIG = %s;\n", string(js))
}

func queryOrEnv(r *http.Request, queryKey, envKey, fallback string) string {
	v := r.URL.Query().Get(queryKey)
	if v != "" {
		return v
	}
	return envOrDefault(envKey, fallback)
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// attachCDNProxies serves MediaPipe + model assets via this origin so system
// browsers (adblock / firewall) only need to reach :5501 — same as the IDE preview.
func attachCDNProxies(mux *http.ServeMux) {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	// NewSingleHostReverseProxy does not set Outbound Host; CDNs (e.g. jsDelivr) reject wrong Host with 421/403.
	newProxy := func(targetURL string, afterDirector func(*http.Request)) *httputil.ReverseProxy {
		u, err := url.Parse(targetURL)
		if err != nil {
			log.Fatalf("cdn proxy: invalid target %q", targetURL)
		}
		p := httputil.NewSingleHostReverseProxy(u)
		p.Transport = transport
		old := p.Director
		p.Director = func(r *http.Request) {
			old(r)
			r.Host = u.Host
			r.Header.Set("Host", u.Host)
			if afterDirector != nil {
				afterDirector(r)
			}
		}
		return p
	}
	// esm.sh re-exports "/@mediapipe/…" for any residual imports; some CDNs return 403 to bare Go clients.
	mux.Handle("/@mediapipe/", newProxy("https://esm.sh", func(r *http.Request) {
		r.Header.Set("User-Agent", "Mozilla/5.0 (compatible; liveness-check-cdn-proxy/1.0)")
		if r.Header.Get("Accept") == "" {
			r.Header.Set("Accept", "*/*")
		}
	}))
	mux.Handle("/proxy/jsdelivr/", http.StripPrefix("/proxy/jsdelivr", newProxy("https://cdn.jsdelivr.net", nil)))
	mux.Handle("/proxy/gcs/", http.StripPrefix("/proxy/gcs", newProxy("https://storage.googleapis.com", nil)))
}
