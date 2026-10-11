//! Exact accounting units. Floating-point USD is for presentation only.
use anyhow::{Result, anyhow, ensure};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MicroUsdPerMtok(pub i64);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NanoUsd(pub i64);

impl MicroUsdPerMtok {
    pub fn new(value: i64) -> Result<Self> {
        ensure!(value >= 0, "negative money rate");
        Ok(Self(value))
    }
}

/// Round half-up exactly once per request/family, never after aggregation.
pub fn request_cost(
    prompt_tokens: u64,
    output_tokens: u64,
    input_rate: MicroUsdPerMtok,
    output_rate: MicroUsdPerMtok,
) -> Result<NanoUsd> {
    ensure!(
        input_rate.0 >= 0 && output_rate.0 >= 0,
        "negative money rate"
    );
    let numerator = i128::from(prompt_tokens)
        .checked_mul(i128::from(input_rate.0))
        .and_then(|input| {
            i128::from(output_tokens)
                .checked_mul(i128::from(output_rate.0))
                .and_then(|output| input.checked_add(output))
        })
        .and_then(|n| n.checked_add(500))
        .ok_or_else(|| anyhow!("request cost overflow"))?;
    Ok(NanoUsd(i64::try_from(numerator / 1000)?))
}

impl NanoUsd {
    pub fn checked_add(self, other: Self) -> Result<Self> {
        Ok(Self(
            self.0
                .checked_add(other.0)
                .ok_or_else(|| anyhow!("money sum overflow"))?,
        ))
    }

    pub fn checked_sum(values: impl IntoIterator<Item = Self>) -> Result<Self> {
        values.into_iter().try_fold(Self(0), Self::checked_add)
    }

    /// Lossy conversion: never use this value in accounting or storage.
    pub fn display_usd(self) -> f64 {
        self.0 as f64 / 1_000_000_000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_cost_and_per_request_rounding() -> Result<()> {
        assert_eq!(
            request_cost(3, 7, MicroUsdPerMtok(2_000_000), MicroUsdPerMtok(8_000_000))?,
            NanoUsd(62_000)
        );
        let cost = request_cost(1, 0, MicroUsdPerMtok(1500), MicroUsdPerMtok(0))?;
        assert_eq!(cost, NanoUsd(2));
        assert_eq!(NanoUsd::checked_sum([cost, cost])?, NanoUsd(4));
        assert_eq!(NanoUsd(1_000_000_000).display_usd(), 1.0);
        Ok(())
    }

    #[test]
    fn rejects_negative_rates_and_overflow() {
        assert!(MicroUsdPerMtok::new(-1).is_err());
        assert!(request_cost(0, 0, MicroUsdPerMtok(-1), MicroUsdPerMtok(0)).is_err());
        assert!(
            request_cost(
                u64::MAX,
                u64::MAX,
                MicroUsdPerMtok(i64::MAX),
                MicroUsdPerMtok(i64::MAX)
            )
            .is_err()
        );
        assert!(request_cost(u64::MAX, 0, MicroUsdPerMtok(i64::MAX), MicroUsdPerMtok(0)).is_err());
        assert!(NanoUsd(i64::MAX).checked_add(NanoUsd(1)).is_err());
        assert!(NanoUsd(i64::MIN).checked_add(NanoUsd(-1)).is_err());
    }
}
