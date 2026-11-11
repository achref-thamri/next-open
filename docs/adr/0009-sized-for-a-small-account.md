# 0009: Sized for a small account

Date: 2026-11-11 · Status: accepted

## Context

Live trading will start with 20,000 kr, about $2,900. The original limits (15 positions of up to 10% each) were set
with the $100,000 paper account in mind. At $2,900 a 10% position is $290, and Next Open buys whole shares only,
because Alpaca's bracket orders don't take fractional quantities. On the first evening with the AI, both picks (MAR
at $432, AMZN at $273) would have rounded down to zero shares. A paper test at $100,000 would also say little about
an account thirty times smaller.

Alpaca's deposit fee (1.5%, capped at $40) is per transfer, so one deposit at or above the cap and no small
withdrawals keep it low. Trades themselves are commission-free.

## Decision

- Risk defaults: at most 5 positions of up to 20% each, 10% cash, and up to 40% of equity traded per day. 40% lets
  one full position be swapped for another in a day (a 20% sell and a 20% buy).
- Stocks whose single share costs more than a full position are left out of the shortlist, for the AI and the
  patient variant, and out of momentum's ranking. The cutoff is equity times the position cap, so it grows with
  the account.
- The momentum rule takes its size from the limits: as many positions as allowed, sharing everything but the cash
  floor (5 × 18% with the defaults).
- The paper account is reset to the live amount, and `npm run reset-paper` clears the paper history so the go-live
  gate, the reports and the virtual portfolios start again from it.

## Consequences

- The go-live clock restarts at the reset. Three months from mid-November puts the earliest live date in mid-February 2027.
- Five positions is concentrated: one stock can move the account by a fifth of its own move. The 3% daily loss stop
  and the stop-loss on every buy stay as they were.
- Stocks above about $580 are out of reach until the account grows.
- The rule tests keep their own limits (15 positions of 10%), so they test the rules and not the defaults.
