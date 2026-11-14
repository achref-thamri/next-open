// Proposals made before this migration had their bracket measured from the limit price, so they keep it as the base.
export const proposalPreviousClose = /* sql */ `
ALTER TABLE proposals ADD COLUMN previous_close INTEGER NOT NULL DEFAULT 0;
UPDATE proposals SET previous_close = limit_price;
`;
