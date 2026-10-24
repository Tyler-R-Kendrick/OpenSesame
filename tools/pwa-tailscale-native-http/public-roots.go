package nativehttp

import (
	"crypto/x509"
	"errors"
	"iter"

	"golang.org/x/crypto/x509roots/fallback/bundle"
)

var errTrust = errors.New("Invalid native HTTPS trust roots.")

// PublicRoots constructs an independent pool from the explicitly pinned NSS
// bundle. It neither reads system/operator roots nor installs process-wide roots.
// The dependency's NSS constraints remain attached to their original roots.
func PublicRoots() (*x509.CertPool, error) {
	return constrainedRootPool(bundle.Roots())
}

func constrainedRootPool(roots iter.Seq[bundle.Root]) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	count := 0
	for root := range roots {
		cert, err := x509.ParseCertificate(root.Certificate)
		if err != nil {
			return nil, errTrust
		}
		if root.Constraint == nil {
			pool.AddCert(cert)
		} else {
			pool.AddCertWithConstraint(cert, root.Constraint)
		}
		count++
	}
	if count == 0 {
		return nil, errTrust
	}
	return pool, nil
}
