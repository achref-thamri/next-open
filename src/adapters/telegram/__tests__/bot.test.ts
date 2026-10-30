import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHandlers, splitMessage, TelegramNotifier, type TelegramHandlers } from "../bot.js";

const OWNER = 42;
const STRANGER = 7;

interface ApiCall {
    method: string;
    payload: Record<string, unknown>;
}

/** A bot whose API calls are recorded instead of sent. */
function fakeBot() {
    const bot = new Bot("123:abc", {
        botInfo: {
            id: 1,
            is_bot: true,
            first_name: "Trading Bot",
            username: "trading_bot",
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
            can_connect_to_business: false,
            has_main_web_app: false,
            has_topics_enabled: false,
            allows_users_to_create_topics: false,
            can_manage_bots: false,
            supports_join_request_queries: false,
        },
    });
    const calls: ApiCall[] = [];
    bot.api.config.use((_prev, method, payload) => {
        calls.push({ method, payload: payload });
        const result =
            method === "sendMessage"
                ? { message_id: calls.length, date: 0, chat: { id: OWNER, type: "private" } }
                : true;
        return Promise.resolve({ ok: true, result } as never);
    });
    return { bot, calls };
}

let updateId = 0;
const message = (chatId: number, text: string): Update => ({
    update_id: ++updateId,
    message: {
        message_id: updateId,
        date: 0,
        chat: { id: chatId, type: "private", first_name: "x" },
        from: { id: chatId, is_bot: false, first_name: "x" },
        text,
    },
});
const button = (chatId: number, data: string): Update => ({
    update_id: ++updateId,
    callback_query: {
        id: `cb${updateId}`,
        chat_instance: "ci",
        from: { id: chatId, is_bot: false, first_name: "x" },
        message: { message_id: 5, date: 0, chat: { id: chatId, type: "private", first_name: "x" }, text: "proposal" },
        data,
    },
});

describe("Telegram handlers", () => {
    let bot: Bot;
    let calls: ApiCall[];
    let handlers: { [K in keyof TelegramHandlers]: ReturnType<typeof vi.fn> & TelegramHandlers[K] };

    beforeEach(() => {
        ({ bot, calls } = fakeBot());
        handlers = {
            onCommand: vi.fn(() => Promise.resolve("status reply")),
            onDecision: vi.fn((_chat: number, id: string, action: string) =>
                Promise.resolve({ ok: true, text: `${action}d ${id}` }),
            ),
            onApproveAll: vi.fn(() => Promise.resolve({ ok: true, text: "Approved 2 of 2." })),
        };
        registerHandlers(bot, OWNER, handlers, pino({ level: "silent" }));
    });

    it("answers the owner's commands", async () => {
        await bot.handleUpdate(message(OWNER, "/status"));

        expect(handlers.onCommand).toHaveBeenCalledWith(OWNER, "/status");
        expect(calls).toEqual([{ method: "sendMessage", payload: { chat_id: OWNER, text: "status reply" } }]);
    });

    it("ignores messages from anyone else, without replying", async () => {
        await bot.handleUpdate(message(STRANGER, "/stop"));

        expect(handlers.onCommand).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });

    it("maps approve and reject buttons to the approval use case", async () => {
        await bot.handleUpdate(button(OWNER, "approve:01ABC"));
        await bot.handleUpdate(button(OWNER, "reject:01DEF"));

        expect(handlers.onDecision.mock.calls).toEqual([
            [OWNER, "01ABC", "approve"],
            [OWNER, "01DEF", "reject"],
        ]);
        expect(calls.map((c) => c.method)).toEqual([
            "answerCallbackQuery",
            "editMessageReplyMarkup",
            "sendMessage",
            "answerCallbackQuery",
            "editMessageReplyMarkup",
            "sendMessage",
        ]);
        expect(calls[0]?.payload).toMatchObject({ text: "approved 01ABC" });
    });

    it("maps the approve-all button", async () => {
        await bot.handleUpdate(button(OWNER, "all:2026-11-03"));

        expect(handlers.onApproveAll).toHaveBeenCalledWith(OWNER, "2026-11-03");
    });

    it("keeps the buttons when the decision failed", async () => {
        handlers.onDecision.mockResolvedValueOnce({ ok: false, text: "Too late." });

        await bot.handleUpdate(button(OWNER, "approve:01ABC"));

        expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
    });

    it("ignores button presses from anyone else", async () => {
        await bot.handleUpdate(button(STRANGER, "approve:01ABC"));

        expect(handlers.onDecision).not.toHaveBeenCalled();
        expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    });
});

describe("TelegramNotifier", () => {
    it("sends text, proposals with buttons and approve-all to the owner", async () => {
        const { bot, calls } = fakeBot();
        const notifier = new TelegramNotifier(bot, OWNER);

        await notifier.send("hello");
        await notifier.sendProposal("BUY 10 AAPL", "01ABC");
        await notifier.sendApproveAll("Approve all 2?", "2026-11-03");

        expect(calls[0]).toEqual({ method: "sendMessage", payload: { chat_id: OWNER, text: "hello" } });
        expect(calls[1]?.payload).toMatchObject({
            chat_id: OWNER,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: "approve:01ABC" },
                        { text: "❌ Reject", callback_data: "reject:01ABC" },
                    ],
                ],
            },
        });
        expect(calls[2]?.payload).toMatchObject({
            reply_markup: { inline_keyboard: [[{ text: "✅ Approve all", callback_data: "all:2026-11-03" }]] },
        });
    });

    it("splits long messages", async () => {
        const { bot, calls } = fakeBot();

        await new TelegramNotifier(bot, OWNER).send("a".repeat(5000));

        expect(calls).toHaveLength(2);
    });
});

describe("splitMessage", () => {
    it("splits at line breaks when possible", () => {
        expect(splitMessage("aaa\nbbb\nccc", 8)).toEqual(["aaa\nbbb", "ccc"]);
        expect(splitMessage("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
        expect(splitMessage("")).toEqual([""]);
    });
});
