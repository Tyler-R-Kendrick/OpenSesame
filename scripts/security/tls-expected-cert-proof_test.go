// Copied only into the pinned upstream tlsdial package by the review workflow.
package tlsdial

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"testing"
	"time"
)

func TestCodeQLExpectedCertHandshakes(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "review CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	makeServer := func(t *testing.T, dns string, notAfter time.Time) tls.Certificate {
		t.Helper()
		leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{dns}, NotBefore: now.Add(-2 * time.Hour), NotAfter: notAfter, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der, caDER}, PrivateKey: key}
	}
	for _, tc := range []struct {
		name, certName, expected  string
		trusted, expired, success bool
	}{
		{"matching name and root", "backend.example", "backend.example", true, false, true},
		{"wrong hostname", "other.example", "backend.example", true, false, false},
		{"untrusted root", "backend.example", "backend.example", false, false, false},
		{"expired certificate", "backend.example", "backend.example", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			notAfter := now.Add(time.Hour)
			if tc.expired {
				notAfter = now.Add(-time.Hour)
			}
			cert := makeServer(t, tc.certName, notAfter)
			roots := x509.NewCertPool()
			if tc.trusted {
				roots.AddCert(ca)
			}
			cfg := &tls.Config{ServerName: "front.example", RootCAs: roots}
			SetConfigExpectedCert(cfg, tc.expected)
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			deadline := time.Now().Add(5 * time.Second)
			if err := client.SetDeadline(deadline); err != nil {
				t.Fatal(err)
			}
			if err := server.SetDeadline(deadline); err != nil {
				t.Fatal(err)
			}
			seenSNI := make(chan string, 1)
			serverTLS := tls.Server(server, &tls.Config{Certificates: []tls.Certificate{cert}, GetConfigForClient: func(info *tls.ClientHelloInfo) (*tls.Config, error) { seenSNI <- info.ServerName; return nil, nil }})
			serverDone := make(chan error, 1)
			go func() { serverDone <- serverTLS.Handshake() }()
			clientTLS := tls.Client(client, cfg)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := clientTLS.HandshakeContext(ctx)
			if (err == nil) != tc.success {
				t.Fatalf("handshake error %v; expected success %v", err, tc.success)
			}
			if got := <-seenSNI; got != "front.example" {
				t.Fatalf("SNI %q", got)
			}
			<-serverDone
		})
	}
}

func TestCodeQLExpectedCertRejectsMissingAndMalformedCertificate(t *testing.T) {
	cfg := &tls.Config{ServerName: "front.example"}
	SetConfigExpectedCert(cfg, "backend.example")
	for _, raw := range [][][]byte{nil, {{0, 1, 2}}} {
		if err := cfg.VerifyPeerCertificate(raw, nil); err == nil {
			t.Fatal("accepted missing or malformed certificate")
		}
	}
}
