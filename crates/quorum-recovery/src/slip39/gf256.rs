//! GF(256) under the Rijndael polynomial x^8 + x^4 + x^3 + x + 1, and Lagrange
//! interpolation over it, as SLIP-0039 fixes them. Shamir's scheme runs on each
//! byte of a secret separately.

use std::sync::OnceLock;

use super::error::Slip39Error;
use crate::secret::Secret;

struct Tables {
    exp: [u8; 255],
    log: [u8; 256],
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut exp = [0_u8; 255];
        let mut log = [0_u8; 256];
        let mut poly: u8 = 1;
        for i in 0..255_u8 {
            exp[usize::from(i)] = poly;
            log[usize::from(poly)] = i;
            // Multiply by x + 1, then reduce by the polynomial: bit 8 of the
            // product is bit 7 of `poly`, and 0x11b without its bit 8 is 0x1b.
            let carry = poly & 0x80 != 0;
            poly = (poly << 1) ^ poly;
            if carry {
                poly ^= 0x1b;
            }
        }
        Tables { exp, log }
    })
}

/// One share: its x coordinate and one y byte per secret byte.
#[derive(Debug, Clone)]
pub struct Point {
    /// The share index.
    pub x: u8,
    /// The share value.
    pub y: Secret,
}

fn check_points(points: &[Point]) -> Result<usize, Slip39Error> {
    let first = points.first().ok_or(Slip39Error::Empty)?;
    let mut seen = [false; 256];
    for point in points {
        if std::mem::replace(&mut seen[usize::from(point.x)], true) {
            return Err(Slip39Error::DuplicateIndex);
        }
        if point.y.len() != first.y.len() {
            return Err(Slip39Error::Interpolation);
        }
    }
    Ok(first.y.len())
}

/// f(x) for the polynomial through `points`, computed per byte. The Lagrange
/// basis is evaluated in the log domain, as the reference implementation does.
///
/// # Errors
/// [`Slip39Error`] when there are no points, two share an index, or their
/// values differ in length.
pub fn interpolate(points: &[Point], x: u8) -> Result<Secret, Slip39Error> {
    let length = check_points(points)?;
    if let Some(hit) = points.iter().find(|p| p.x == x) {
        return Ok(hit.y.clone());
    }
    let Tables { exp, log } = tables();
    let log_of = |value: u8| usize::from(log[usize::from(value)]);
    let log_product: usize = points.iter().map(|p| log_of(p.x ^ x)).sum();
    let mut result = vec![0_u8; length];
    for point in points {
        let denominator: usize = points.iter().map(|other| log_of(point.x ^ other.x)).sum();
        let numerator = log_product - log_of(point.x ^ x);
        // Adding 255 per point keeps the subtraction from underflowing; it
        // changes nothing modulo 255.
        let log_basis = (numerator + 255 * points.len() - denominator) % 255;
        for (out, &y) in result.iter_mut().zip(point.y.expose()) {
            if y != 0 {
                *out ^= exp[(log_of(y) + log_basis) % 255];
            }
        }
    }
    Ok(Secret::new(result))
}

#[cfg(test)]
mod tests {
    use super::{interpolate, tables, Point};
    use crate::secret::Secret;

    #[test]
    fn the_tables_are_the_rijndael_field() {
        let t = tables();
        assert_eq!(t.exp[0], 1);
        assert_eq!(t.exp[1], 3);
        // Every nonzero element appears exactly once as a power of the generator.
        let mut seen = [false; 256];
        for &e in &t.exp {
            assert!(!std::mem::replace(&mut seen[usize::from(e)], true));
        }
        assert!(!seen[0]);
    }

    #[test]
    fn a_line_through_two_points_evaluates_at_a_third() {
        // f(x) = 5 + 7x over GF(256) is not computed by hand here: the secret
        // at 255 and the point at 0 fix the line, and evaluating at an
        // existing x must hand back that share.
        let a = Point {
            x: 0,
            y: Secret::new(vec![0x10, 0x20]),
        };
        let b = Point {
            x: 255,
            y: Secret::new(vec![0x33, 0x44]),
        };
        let pts = [a, b];
        assert_eq!(interpolate(&pts, 0).unwrap().expose(), [0x10, 0x20]);
        let mid = interpolate(&pts, 1).unwrap().expose().to_vec();
        // The line is determined, so recomputing from {0, 1} must give 255 back.
        let again = [
            pts[0].clone(),
            Point {
                x: 1,
                y: Secret::new(mid),
            },
        ];
        assert_eq!(interpolate(&again, 255).unwrap().expose(), [0x33, 0x44]);
    }

    #[test]
    fn refuses_duplicate_indices_and_ragged_values() {
        let p = |x, n| Point {
            x,
            y: Secret::new(vec![1; n]),
        };
        assert!(interpolate(&[p(1, 2), p(1, 2)], 3).is_err());
        assert!(interpolate(&[p(1, 2), p(2, 3)], 3).is_err());
        assert!(interpolate(&[], 3).is_err());
    }
}
