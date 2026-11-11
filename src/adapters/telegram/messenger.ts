import { InlineKeyboard, type Bot as TelegramClient, type Context } from "grammy";
import type { Logger } from "../../lib/logger.js";
import type { Notifier } from "../../ports/notifier.js";

/** Telegram's message length limit. */
const MAX_MESSAGE_LENGTH = 4096;

/** What Next Open does with the owner's input; each returns the reply to show. */
export interface TelegramHandlers {
    onCommand(chatId: number, text: string): Promise<string | undefined>;
    onDecision(
        chatId: number,
        proposalId: string,
        action: "approve" | "reject",
    ): Promise<{ ok: boolean; text: string }>;
    onApproveAll(chatId: number, tradeDate: string): Promise<{ ok: boolean; text: string }>;
}

/** Notifier that sends plain-text messages, with inline buttons for approvals, to the owner's chat. */
export class TelegramNotifier implements Notifier {
    constructor(
        private readonly telegram: TelegramClient,
        private readonly ownerChatId: number,
    ) {}

    async send(text: string): Promise<void> {
        for (const chunk of splitMessage(text)) await this.telegram.api.sendMessage(this.ownerChatId, chunk);
    }

    async sendProposal(text: string, proposalId: string): Promise<void> {
        const keyboard = new InlineKeyboard()
            .text("✅ Approve", `approve:${proposalId}`)
            .text("❌ Reject", `reject:${proposalId}`);
        await this.telegram.api.sendMessage(this.ownerChatId, text.slice(0, MAX_MESSAGE_LENGTH), {
            reply_markup: keyboard,
        });
    }

    async sendApproveAll(text: string, tradeDate: string): Promise<void> {
        const keyboard = new InlineKeyboard().text("✅ Approve all", `all:${tradeDate}`);
        await this.telegram.api.sendMessage(this.ownerChatId, text, { reply_markup: keyboard });
    }
}

/**
 * Fills the command menu next to the message box. It is set for the owner's chat only, so anyone else who finds
 * the account sees no commands.
 */
export async function setCommandMenu(
    telegram: TelegramClient,
    ownerChatId: number,
    commands: readonly { command: string; description: string }[],
): Promise<void> {
    await telegram.api.setMyCommands(
        commands.map(({ command, description }) => ({ command, description })),
        { scope: { type: "chat", chat_id: ownerChatId } },
    );
}

/**
 * Wires commands and approval buttons. Only the owner's private chat is served; everything else is ignored
 * without a reply, so Next Open does not reveal itself to strangers.
 */
export function registerHandlers(
    telegram: TelegramClient,
    ownerChatId: number,
    handlers: TelegramHandlers,
    logger: Logger,
): void {
    const isOwner = (ctx: Context) => ctx.chat?.id === ownerChatId && ctx.from?.id === ownerChatId;

    telegram.on("message:text", async (ctx) => {
        if (!isOwner(ctx)) {
            logger.warn({ chatId: ctx.chat.id }, "ignored message from another chat");
            return;
        }
        const reply = await handlers.onCommand(ctx.chat.id, ctx.message.text);
        if (reply) for (const chunk of splitMessage(reply)) await ctx.reply(chunk);
    });

    telegram.on("callback_query:data", async (ctx) => {
        if (!isOwner(ctx)) {
            logger.warn({ chatId: ctx.chat?.id }, "ignored button press from another chat");
            await ctx.answerCallbackQuery();
            return;
        }
        const [kind, value = ""] = splitOnce(ctx.callbackQuery.data, ":");
        const chatId = ownerChatId;
        const result =
            kind === "approve" || kind === "reject"
                ? await handlers.onDecision(chatId, value, kind)
                : kind === "all"
                  ? await handlers.onApproveAll(chatId, value)
                  : { ok: false, text: "Unknown button." };
        await ctx.answerCallbackQuery({ text: result.text });
        // Remove the buttons once the decision is final, and show the outcome under the message.
        if (result.ok) await ctx.editMessageReplyMarkup();
        await ctx.reply(result.text);
    });

    telegram.catch((error) => {
        logger.error({ err: error.error }, "telegram handler failed");
    });
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
    const index = text.indexOf(separator);
    return index < 0 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
}

/** Splits text into Telegram-sized messages, preferring line breaks. */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > max) {
        const cut = rest.lastIndexOf("\n", max);
        const at = cut > 0 ? cut : max;
        chunks.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^\n/, "");
    }
    if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
    return chunks;
}
