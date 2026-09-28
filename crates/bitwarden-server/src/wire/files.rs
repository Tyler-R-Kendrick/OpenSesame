//! How clients show a file's size.

/// "16 Bytes", "1.5 KB": how clients show a size, to two decimals.
#[must_use]
pub fn size_name(size: i64) -> String {
    const UNITS: [&str; 4] = ["Bytes", "KB", "MB", "GB"];
    let mut unit = 0;
    let mut scale: i64 = 1;
    while unit < UNITS.len() - 1 && size >= scale * 1024 {
        scale *= 1024;
        unit += 1;
    }
    if unit == 0 {
        return format!("{size} Bytes");
    }
    // Hundredths, rounded half up, without floating point.
    let hundredths = (size * 100 + scale / 2) / scale;
    let (whole, fraction) = (hundredths / 100, hundredths % 100);
    let number = match fraction {
        0 => whole.to_string(),
        f if f % 10 == 0 => format!("{whole}.{}", f / 10),
        f => format!("{whole}.{f:02}"),
    };
    format!("{number} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_the_way_clients_show_them() {
        assert_eq!(size_name(16), "16 Bytes");
        assert_eq!(size_name(1536), "1.5 KB");
        assert_eq!(size_name(5 * 1024 * 1024), "5 MB");
        assert_eq!(size_name(1234), "1.21 KB");
    }
}
