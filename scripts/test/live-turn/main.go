// live-turn is the TURN server verify:live-join runs (ADR 0150 §6) when a walk
// proves authenticated TURN over UDP, over TCP
// and over TLS at once, on one loopback address, with long-term credentials
// (RFC 8656 / RFC 5766, RFC 6062 not used) — built on pion/turn.
//
//	live-turn serve -user U -credential C [-cert cert.pem -key key.pem]
//	live-turn serve -rest-secret S        [-cert cert.pem -key key.pem]
//	live-turn mint <dir>          # writes cert.pem and key.pem, self-signed
//
// With -rest-secret the credentials are TURN REST ones (draft-uberti-behave-
// turn-rest, coturn's use-auth-secret): a username "<unix expiry>:<anything>"
// and base64(HMAC-SHA1(secret, username)), which is what the app mints for a
// session from the owner's "secret".
//
// serve prints one JSON line when it listens —
// {"ready":true,"udp":N,"tcp":N,"tls":N,"stats":N} — on ports the kernel chose,
// then answers GET /stats on 127.0.0.1:<stats> with what each transport saw:
// datagrams or connections and bytes that reached it, and the authentications
// and allocations that came in on it. A walk reads that to say which transport
// a browser really used; the browser's own report cannot say it.
//
// It is value-blind: it never logs a name, a credential, a peer or a payload.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

const realm = "live"

func main() {
	if len(os.Args) < 2 {
		fail("usage: live-turn serve|mint")
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "mint":
		if len(os.Args) != 3 {
			fail("usage: live-turn mint <dir>")
		}
		mint(os.Args[2])
	default:
		fail("usage: live-turn serve|mint")
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "live-turn:", message)
	os.Exit(2)
}

func check(err error) {
	if err != nil {
		fail(err.Error())
	}
}

// mint writes a throwaway self-signed certificate for 127.0.0.1 and its key.
func mint(dir string) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	check(err)
	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "live-turn"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	check(err)
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	check(err)
	check(os.MkdirAll(dir, 0o700))
	write := func(name, kind string, bytes []byte) {
		block := pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: bytes})
		check(os.WriteFile(filepath.Join(dir, name), block, 0o600))
	}
	write("cert.pem", "CERTIFICATE", der)
	write("key.pem", "PRIVATE KEY", keyDER)
}

func serve(args []string) {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := flags.String("listen", "127.0.0.1", "local IPv4 listener and relay address")
	user := flags.String("user", "", "long-term credential name")
	credential := flags.String("credential", "", "long-term credential secret")
	restSecret := flags.String("rest-secret", "", "TURN REST shared secret, instead of -user and -credential")
	certFile := flags.String("cert", "", "TLS certificate (PEM); with -key, adds the TLS listener")
	keyFile := flags.String("key", "", "TLS private key (PEM)")
	check(flags.Parse(args))
	static := *user != "" && *credential != ""
	if static == (*restSecret != "") {
		fail("serve needs -rest-secret, or -user and -credential")
	}

	stats := newStats()
	address := net.ParseIP(*listen)
	if address == nil || address.To4() == nil {
		fail("listen needs a local IPv4 address")
	}
	bind := net.JoinHostPort(*listen, "0")
	relay := func() turn.RelayAddressGenerator {
		return &turn.RelayAddressGeneratorStatic{RelayAddress: address, Address: *listen}
	}
	ready := map[string]any{"ready": true}
	config := turn.ServerConfig{
		Realm:        realm,
		AuthHandler:  authHandler(*user, *credential, *restSecret),
		EventHandler: stats.events(),
	}

	udp, err := net.ListenPacket("udp4", bind)
	check(err)
	ready["udp"] = port(udp.LocalAddr())
	stats.name(port(udp.LocalAddr()), "udp")
	config.PacketConnConfigs = []turn.PacketConnConfig{{
		PacketConn: stats.countPackets("udp", udp), RelayAddressGenerator: relay(),
	}}

	tcp, err := net.Listen("tcp4", bind)
	check(err)
	ready["tcp"] = port(tcp.Addr())
	stats.name(port(tcp.Addr()), "tcp")
	config.ListenerConfigs = []turn.ListenerConfig{{
		Listener: stats.countAccepts("tcp", tcp), RelayAddressGenerator: relay(),
	}}

	if *certFile != "" || *keyFile != "" {
		pair, err := tls.LoadX509KeyPair(*certFile, *keyFile)
		check(err)
		inner, err := net.Listen("tcp4", bind)
		check(err)
		ready["tls"] = port(inner.Addr())
		stats.name(port(inner.Addr()), "tls")
		secured := tls.NewListener(stats.countAccepts("tls", inner), &tls.Config{
			Certificates: []tls.Certificate{pair},
			MinVersion:   tls.VersionTLS12,
			GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
				stats.hello("tls")
				return nil, nil
			},
		})
		config.ListenerConfigs = append(config.ListenerConfigs, turn.ListenerConfig{
			Listener: secured, RelayAddressGenerator: relay(),
		})
	}

	_, err = turn.NewServer(config)
	check(err)

	control, err := net.Listen("tcp4", "127.0.0.1:0")
	check(err)
	ready["stats"] = port(control.Addr())
	mux := http.NewServeMux()
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		check(json.NewEncoder(w).Encode(stats.snapshot()))
	})
	go func() { check(http.Serve(control, mux)) }()

	check(json.NewEncoder(os.Stdout).Encode(ready))
	select {}
}

func port(addr net.Addr) int {
	switch a := addr.(type) {
	case *net.UDPAddr:
		return a.Port
	case *net.TCPAddr:
		return a.Port
	}
	return 0
}

// authHandler is static long-term credentials, or TURN REST ones for a secret.
// The REST handler's own logger would print the username it refuses; this one
// prints nothing.
func authHandler(user, credential, restSecret string) turn.AuthHandler {
	if restSecret != "" {
		quiet := &logging.DefaultLoggerFactory{
			Writer:          io.Discard,
			DefaultLogLevel: logging.LogLevelDisabled,
		}
		return turn.LongTermTURNRESTAuthHandler(restSecret, quiet.NewLogger("turn"))
	}
	return func(name, _ string, _ net.Addr) ([]byte, bool) {
		if name != user {
			return nil, false
		}
		return turn.GenerateAuthKey(name, realm, credential), true
	}
}
