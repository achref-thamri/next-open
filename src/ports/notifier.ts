/** Messages to the owner. Text is plain; the use cases format it. */
export interface Notifier {
    send(text: string): Promise<void>;
    /** A proposal message with Approve and Reject buttons. */
    sendProposal(text: string, proposalId: string): Promise<void>;
    /** A message with an Approve all button for every pending proposal of the trade date. */
    sendApproveAll(text: string, tradeDate: string): Promise<void>;
}
