require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const WEB_APP_URL = String(process.env.WEB_APP_URL || "").trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "").trim();
const PAYMENT_ADDRESS = String(process.env.PAYMENT_ADDRESS || "").trim();

const DATABASE_FILE = String(
    process.env.DATABASE_FILE || "frickbingo.db"
).trim();

const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;

const GAME_STAKES = [10, 20];
const MAX_CARDS = 2;

const WIN_RATE = 0.85;

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   DATABASE
========================================================= */

const db = new Database(DATABASE_FILE);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("✅ Database connected");

/* =========================================================
   DATABASE TABLES
========================================================= */

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        username TEXT DEFAULT '',
        first_name TEXT DEFAULT '',
        balance REAL NOT NULL DEFAULT 0,
        play_balance REAL NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        reference TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        account_details TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        stake REAL NOT NULL,
        cards INTEGER NOT NULL,

        result TEXT DEFAULT 'STARTED',
        prize REAL NOT NULL DEFAULT 0,

        card_number INTEGER,

        status TEXT NOT NULL DEFAULT 'STARTED',

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,

        FOREIGN KEY (user_id) REFERENCES users(id)
    );
`);

/* =========================================================
   SAFE MIGRATION
========================================================= */

function columnExists(tableName, columnName) {
    const columns = db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all();

    return columns.some(
        column => column.name === columnName
    );
}

function addColumnIfMissing(
    tableName,
    columnName,
    definition
) {
    if (!columnExists(tableName, columnName)) {
        try {
            db.prepare(
                `ALTER TABLE ${tableName}
                 ADD COLUMN ${columnName} ${definition}`
            ).run();

            console.log(
                `✅ Added ${tableName}.${columnName}`
            );

        } catch (error) {
            console.error(
                `❌ Migration error ${tableName}.${columnName}:`,
                error.message
            );
        }
    }
}

/*
    These columns record exactly where the stake
    came from.

    Example:

    stake = 20
    play_spent = 12
    main_spent = 8
*/

addColumnIfMissing(
    "games",
    "play_spent",
    "REAL NOT NULL DEFAULT 0"
);

addColumnIfMissing(
    "games",
    "main_spent",
    "REAL NOT NULL DEFAULT 0"
);

addColumnIfMissing(
    "withdrawals",
    "telegram_id",
    "TEXT"
);

addColumnIfMissing(
    "withdrawals",
    "account_details",
    "TEXT"
);

/* =========================================================
   HELPERS
========================================================= */

function num(value) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return 0;
    }

    return Math.round(
        (n + Number.EPSILON) * 100
    ) / 100;
}

function money(value) {
    return num(value).toFixed(2);
}

function getUser(telegramId) {
    return db
        .prepare(`
            SELECT *
            FROM users
            WHERE telegram_id = ?
        `)
        .get(String(telegramId));
}

function getUserById(userId) {
    return db
        .prepare(`
            SELECT *
            FROM users
            WHERE id = ?
        `)
        .get(Number(userId));
}

function getOrCreateUser(from) {

    if (!from || from.id == null) {
        throw new Error(
            "Telegram user ID missing."
        );
    }

    const telegramId = String(from.id);

    const username =
        from.username
            ? String(from.username)
            : "";

    const firstName =
        from.first_name
            ? String(from.first_name)
            : "";

    let user = getUser(telegramId);

    if (!user) {

        db.prepare(`
            INSERT INTO users (
                telegram_id,
                username,
                first_name,
                balance,
                play_balance
            )
            VALUES (?, ?, ?, 0, 0)
        `).run(
            telegramId,
            username,
            firstName
        );

    } else {

        db.prepare(`
            UPDATE users
            SET
                username = ?,
                first_name = ?
            WHERE telegram_id = ?
        `).run(
            username,
            firstName,
            telegramId
        );
    }

    return getUser(telegramId);
}

/* =========================================================
   TELEGRAM WEB APP AUTH
========================================================= */

function validateInitData(initData) {

    if (!initData || !BOT_TOKEN) {
        return null;
    }

    try {

        const params =
            new URLSearchParams(initData);

        const receivedHash =
            params.get("hash");

        if (!receivedHash) {
            return null;
        }

        params.delete("hash");

        const dataCheckString =
            [...params.entries()]
                .sort(([a], [b]) =>
                    a.localeCompare(b)
                )
                .map(([key, value]) =>
                    `${key}=${value}`
                )
                .join("\n");

        const secretKey =
            crypto
                .createHmac(
                    "sha256",
                    "WebAppData"
                )
                .update(BOT_TOKEN)
                .digest();

        const calculatedHash =
            crypto
                .createHmac(
                    "sha256",
                    secretKey
                )
                .update(dataCheckString)
                .digest("hex");

        const a =
            Buffer.from(
                calculatedHash,
                "hex"
            );

        const b =
            Buffer.from(
                receivedHash,
                "hex"
            );

        if (
            a.length !== b.length ||
            !crypto.timingSafeEqual(a, b)
        ) {
            return null;
        }

        const userData =
            params.get("user");

        if (!userData) {
            return null;
        }

        return JSON.parse(userData);

    } catch (error) {

        console.error(
            "Telegram auth error:",
            error.message
        );

        return null;
    }
}

/* =========================================================
   AUTH
========================================================= */

function auth(req, res, next) {

    try {

        const initData =
            req.headers[
                "x-telegram-init-data"
            ] || "";

        const telegramUser =
            validateInitData(initData);

        if (
            !telegramUser ||
            telegramUser.id == null
        ) {

            return res.status(401).json({
                ok: false,
                error:
                    "Invalid Telegram authentication."
            });
        }

        req.tgUser =
            telegramUser;

        req.user =
            getOrCreateUser(
                telegramUser
            );

        next();

    } catch (error) {

        console.error(
            "Auth error:",
            error
        );

        return res.status(401).json({
            ok: false,
            error:
                "Authentication failed."
        });
    }
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/api/health",
    (req, res) => {

        res.json({
            ok: true,
            status: "online",
            database: "connected",
            time: new Date().toISOString()
        });
    }
);

/* =========================================================
   HOME
========================================================= */

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );
    }
);

/* =========================================================
   USER
========================================================= */

app.get(
    "/api/me",
    auth,
    (req, res) => {

        const user =
            getUserById(
                req.user.id
            );

        res.json({
            ok: true,

            user: {
                telegramId:
                    String(user.telegram_id),

                username:
                    user.username || "",

                firstName:
                    user.first_name || "",

                mainBalance:
                    num(user.balance),

                playBalance:
                    num(user.play_balance)
            }
        });
    }
);

/* =========================================================
   BALANCE
========================================================= */

app.get(
    "/api/balance",
    auth,
    (req, res) => {

        const user =
            getUserById(
                req.user.id
            );

        res.json({
            ok: true,

            mainBalance:
                num(user.balance),

            playBalance:
                num(user.play_balance),

            totalBalance:
                num(
                    Number(user.balance) +
                    Number(user.play_balance)
                )
        });
    }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
    "/api/history",
    auth,
    (req, res) => {

        const userId =
            req.user.id;

        const deposits =
            db.prepare(`
                SELECT
                    id,
                    amount,
                    reference,
                    status,
                    created_at,
                    approved_at
                FROM deposits
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT 100
            `).all(userId);

        const withdrawals =
            db.prepare(`
                SELECT
                    id,
                    amount,
                    account_details,
                    status,
                    created_at,
                    approved_at
                FROM withdrawals
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT 100
            `).all(userId);

        const games =
            db.prepare(`
                SELECT
                    id,
                    stake,
                    cards,
                    result,
                    prize,
                    card_number,
                    status,
                    play_spent,
                    main_spent,
                    created_at,
                    finished_at
                FROM games
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT 100
            `).all(userId);

        res.json({
            ok: true,
            deposits,
            withdrawals,
            games
        });
    }
);

/* =========================================================
   GAME START
========================================================= */

app.post(
    "/api/game/start",
    auth,
    (req, res) => {

        try {

            const stake =
                Number(req.body?.stake);

            const cards =
                Number(req.body?.cards);

            if (
                !GAME_STAKES.includes(stake)
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Invalid stake."
                });
            }

            if (
                !Number.isInteger(cards) ||
                cards < 1 ||
                cards > MAX_CARDS
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Cards must be 1 or 2."
                });
            }

            /*
                TOTAL COST

                Example:
                stake = 20
                cards = 2

                cost = 40
            */

            const cost =
                num(
                    stake * cards
                );

            const result =
                db.transaction(() => {

                    const user =
                        getUserById(
                            req.user.id
                        );

                    if (!user) {
                        throw new Error(
                            "User not found."
                        );
                    }

                    const main =
                        num(user.balance);

                    const play =
                        num(user.play_balance);

                    const total =
                        num(
                            main + play
                        );

                    /*
                        IMPORTANT:

                        Play Wallet is used FIRST.

                        If Play has 12
                        and cost is 20:

                        Play spends 12
                        Main spends 8
                    */

                    if (total < cost) {

                        throw new Error(
                            `Insufficient balance. ` +
                            `You need ${money(cost)} ETB. ` +
                            `Main: ${money(main)} ETB, ` +
                            `Play: ${money(play)} ETB.`
                        );
                    }

                    const playSpent =
                        num(
                            Math.min(
                                play,
                                cost
                            )
                        );

                    const mainSpent =
                        num(
                            cost - playSpent
                        );

                    /*
                        ATOMIC BALANCE UPDATE
                    */

                    const update =
                        db.prepare(`
                            UPDATE users
                            SET
                                balance =
                                    balance - ?,

                                play_balance =
                                    play_balance - ?

                            WHERE
                                id = ?

                                AND balance >= ?

                                AND play_balance >= ?
                        `).run(
                            mainSpent,
                            playSpent,
                            user.id,
                            mainSpent,
                            playSpent
                        );

                    if (
                        update.changes !== 1
                    ) {

                        throw new Error(
                            "Balance changed. Please try again."
                        );
                    }

                    /*
                        Save where the stake came from.

                        This is important for auditing
                        and future refund/cancel logic.
                    */

                    const game =
                        db.prepare(`
                            INSERT INTO games (
                                user_id,
                                stake,
                                cards,
                                result,
                                prize,
                                status,
                                play_spent,
                                main_spent
                            )
                            VALUES (
                                ?,
                                ?,
                                ?,
                                'STARTED',
                                0,
                                'STARTED',
                                ?,
                                ?
                            )
                        `).run(
                            user.id,
                            stake,
                            cards,
                            playSpent,
                            mainSpent
                        );

                    return {
                        gameId:
                            Number(
                                game.lastInsertRowid
                            ),

                        cost,

                        playSpent,

                        mainSpent
                    };

                })();

            const fresh =
                getUserById(
                    req.user.id
                );

            res.json({

                ok: true,

                gameId:
                    result.gameId,

                cost:
                    result.cost,

                playSpent:
                    result.playSpent,

                mainSpent:
                    result.mainSpent,

                mainBalance:
                    num(
                        fresh.balance
                    ),

                playBalance:
                    num(
                        fresh.play_balance
                    )
            });

        } catch (error) {

            console.error(
                "Game start:",
                error
            );

            res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   GAME FINISH
========================================================= */

app.post(
    "/api/game/finish",
    auth,
    (req, res) => {

        try {

            const gameId =
                Number(
                    req.body?.gameId
                );

            const result =
                String(
                    req.body?.result || ""
                ).toUpperCase();

            const cardNumber =
                req.body?.cardNumber == null
                    ? null
                    : Number(
                        req.body.cardNumber
                    );

            if (
                !Number.isInteger(gameId) ||
                gameId < 1
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Invalid game ID."
                });
            }

            if (
                !["WIN", "LOSE"].includes(
                    result
                )
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Invalid result."
                });
            }

            const output =
                db.transaction(() => {

                    const game =
                        db.prepare(`
                            SELECT *
                            FROM games
                            WHERE
                                id = ?
                                AND user_id = ?
                        `).get(
                            gameId,
                            req.user.id
                        );

                    if (!game) {

                        throw new Error(
                            "Game not found."
                        );
                    }

                    if (
                        game.status !==
                        "STARTED"
                    ) {

                        throw new Error(
                            "Game already finished."
                        );
                    }

                    const cost =
                        num(
                            game.stake *
                            game.cards
                        );

                    /*
                        IMPORTANT:

                        THE STAKE IS NOT DEDUCTED AGAIN.

                        It was already deducted
                        in /api/game/start.
                    */

                    const prize =
                        result === "WIN"
                            ? num(
                                cost *
                                WIN_RATE
                            )
                            : 0;

                    /*
                        WIN PRIZE ALWAYS GOES
                        TO MAIN WALLET.
                    */

                    if (prize > 0) {

                        const balanceUpdate =
                            db.prepare(`
                                UPDATE users
                                SET balance =
                                    balance + ?
                                WHERE id = ?
                            `).run(
                                prize,
                                req.user.id
                            );

                        if (
                            balanceUpdate.changes !== 1
                        ) {

                            throw new Error(
                                "Prize balance update failed."
                            );
                        }
                    }

                    /*
                        Finish game.

                        No stake deduction here.
                    */

                    const gameUpdate =
                        db.prepare(`
                            UPDATE games
                            SET
                                result = ?,
                                prize = ?,
                                card_number = ?,
                                status = 'FINISHED',
                                finished_at =
                                    CURRENT_TIMESTAMP

                            WHERE
                                id = ?
                                AND user_id = ?
                                AND status = 'STARTED'
                        `).run(
                            result,
                            prize,
                            cardNumber,
                            gameId,
                            req.user.id
                        );

                    if (
                        gameUpdate.changes !== 1
                    ) {

                        throw new Error(
                            "Game was already finished."
                        );
                    }

                    return {
                        cost,
                        prize,
                        playSpent:
                            num(
                                game.play_spent
                            ),
                        mainSpent:
                            num(
                                game.main_spent
                            )
                    };

                })();

            const fresh =
                getUserById(
                    req.user.id
                );

            res.json({

                ok: true,

                cost:
                    output.cost,

                prize:
                    output.prize,

                playSpent:
                    output.playSpent,

                mainSpent:
                    output.mainSpent,

                mainBalance:
                    num(
                        fresh.balance
                    ),

                playBalance:
                    num(
                        fresh.play_balance
                    )
            });

        } catch (error) {

            console.error(
                "Game finish:",
                error
            );

            res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   TELEGRAM BOT
========================================================= */

let bot = null;

const depositStates =
    new Map();

const withdrawStates =
    new Map();

/* =========================================================
   BOT KEYBOARD
========================================================= */

function keyboard() {

    const rows = [];

    if (WEB_APP_URL) {

        rows.push([
            {
                text:
                    "🎮 PLAY BINGO",

                web_app: {
                    url:
                        WEB_APP_URL
                }
            }
        ]);
    }

    rows.push(
        [
            {
                text:
                    "📝 Register",

                callback_data:
                    "register"
            }
        ],

        [
            {
                text:
                    "💰 Balance",

                callback_data:
                    "balance"
            }
        ],

        [
            {
                text:
                    "💳 Deposit",

                callback_data:
                    "deposit"
            },

            {
                text:
                    "💸 Withdraw",

                callback_data:
                    "withdraw"
            }
        ],

        [
            {
                text:
                    "🎮 Games",

                callback_data:
                    "games"
            }
        ]
    );

    return {
        inline_keyboard:
            rows
    };
}

/* =========================================================
   START BOT
========================================================= */

if (BOT_TOKEN) {

    bot =
        new TelegramBot(
            BOT_TOKEN,
            {
                polling: true
            }
        );

    console.log(
        "🤖 Telegram bot polling started"
    );

    /* =====================================================
       /start
    ===================================================== */

    bot.onText(
        /^\/start(?:\s+.*)?$/i,
        async msg => {

            try {

                getOrCreateUser(
                    msg.from
                );

                await bot.sendMessage(
                    msg.chat.id,

                    `🎉 Welcome to Frick Bingo!

🎱 Play Bingo
💰 Check Balance
💳 Deposit
💸 Withdraw
🏆 Game`,

                    {
                        reply_markup:
                            keyboard()
                    }
                );

            } catch (error) {

                console.error(
                    "/start:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /register
    ===================================================== */

    bot.onText(
        /^\/register$/i,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                await bot.sendMessage(
                    msg.chat.id,

                    `✅ Registration successful!

👤 ${user.first_name || ""}

🆔 ${user.telegram_id}

💵 Main Balance:
${money(user.balance)} ETB

🎮 Play Balance:
${money(user.play_balance)} ETB`
                );

            } catch (error) {

                console.error(
                    "/register:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /balance
    ===================================================== */

    bot.onText(
        /^\/balance$/i,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                await bot.sendMessage(
                    msg.chat.id,

                    `💰 BALANCE

💵 Main Wallet:
${money(user.balance)} ETB

🎮 Play Wallet:
${money(user.play_balance)} ETB

💰 Total:
${money(
    Number(user.balance) +
    Number(user.play_balance)
)} ETB`
                );

            } catch (error) {

                console.error(
                    "/balance:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /deposit
    ===================================================== */

    bot.onText(
        /^\/deposit$/i,
        async msg => {

            try {

                getOrCreateUser(
                    msg.from
                );

                depositStates.set(
                    String(msg.from.id),
                    {
                        step:
                            "amount"
                    }
                );

                await bot.sendMessage(
                    msg.chat.id,

                    `💳 DEPOSIT

Send your deposit amount in ETB.

Minimum:
${MIN_DEPOSIT} ETB

Payment address:
${PAYMENT_ADDRESS || "Not configured"}

Please send only the amount first.`
                );

            } catch (error) {

                console.error(
                    "/deposit:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /withdraw
    ===================================================== */

    bot.onText(
        /^\/withdraw$/i,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                if (
                    Number(user.balance) <
                    MIN_WITHDRAW
                ) {

                    return bot.sendMessage(
                        msg.chat.id,

                        `❌ Minimum withdrawal is ${MIN_WITHDRAW} ETB.

💵 Main Wallet:
${money(user.balance)} ETB

🎮 Play Wallet:
${money(user.play_balance)} ETB

⚠️ Only Main Wallet can be withdrawn.`
                    );
                }

                withdrawStates.set(
                    String(msg.from.id),
                    {
                        step:
                            "amount"
                    }
                );

                await bot.sendMessage(
                    msg.chat.id,

                    `💸 WITHDRAW

Withdrawal is taken from your Main Wallet only.

Send withdrawal amount in ETB.

Minimum:
${MIN_WITHDRAW} ETB`
                );

            } catch (error) {

                console.error(
                    "/withdraw:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /play
    ===================================================== */

    bot.onText(
        /^\/play$/i,
        async msg => {

            if (!WEB_APP_URL) {

                return bot.sendMessage(
                    msg.chat.id,
                    "❌ WEB_APP_URL is not configured."
                );
            }

            await bot.sendMessage(
                msg.chat.id,
                "🎮 Open Frick Bingo:",

                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text:
                                        "🎮 PLAY BINGO",

                                    web_app: {
                                        url:
                                            WEB_APP_URL
                                    }
                                }
                            ]
                        ]
                    }
                }
            );
        }
    );

    /* =====================================================
       /games
    ===================================================== */

    bot.onText(
        /^\/games$/i,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                const games =
                    db.prepare(`
                        SELECT
                            id,
                            result,
                            stake,
                            cards,
                            prize,
                            status,
                            play_spent,
                            main_spent
                        FROM games
                        WHERE user_id = ?
                        ORDER BY id DESC
                        LIMIT 10
                    `).all(user.id);

                if (!games.length) {

                    return bot.sendMessage(
                        msg.chat.id,
                        "🎮 No games yet."
                    );
                }

                let text =
                    "🎮 Recent Games\n\n";

                for (
                    const game of games
                ) {

                    text +=
                        `#${game.id} • ` +
                        `${game.result || game.status} • ` +
                        `Stake: ${money(
                            game.stake *
                            game.cards
                        )} ETB • ` +
                        `Prize: ${money(
                            game.prize
                        )} ETB\n`;
                }

                await bot.sendMessage(
                    msg.chat.id,
                    text
                );

            } catch (error) {

                console.error(
                    "/games:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /help
    ===================================================== */

    bot.onText(
        /^\/help$/i,
        async msg => {

            await bot.sendMessage(
                msg.chat.id,

                `📚 Frick Bingo Help

/start
/register
/play
/balance
/deposit
/withdraw
/games
/help`
            );
        }
    );

    /* =====================================================
       USER MESSAGE STATE HANDLER
    ===================================================== */

    bot.on(
        "message",
        async msg => {

            try {

                if (
                    !msg.text ||
                    msg.text.startsWith("/")
                ) {
                    return;
                }

                const tid =
                    String(msg.from.id);

                /* =========================================
                   DEPOSIT
                ========================================= */

                const deposit =
                    depositStates.get(tid);

                if (deposit) {

                    /* -------------------------------------
                       DEPOSIT AMOUNT
                    ------------------------------------- */

                    if (
                        deposit.step ===
                        "amount"
                    ) {

                        const amount =
                            num(
                                msg.text.trim()
                            );

                        if (
                            !Number.isFinite(
                                amount
                            ) ||
                            amount <
                            MIN_DEPOSIT
                        ) {

                            return bot.sendMessage(
                                msg.chat.id,

                                `❌ Minimum deposit is ${MIN_DEPOSIT} ETB.`
                            );
                        }

                        deposit.amount =
                            amount;

                        deposit.step =
                            "reference";

                        depositStates.set(
                            tid,
                            deposit
                        );

                        return bot.sendMessage(
                            msg.chat.id,

                            `💰 Amount:
${money(amount)} ETB

Now send your payment transaction/reference number.`
                        );
                    }

                    /* -------------------------------------
                       DEPOSIT REFERENCE
                    ------------------------------------- */

                    if (
                        deposit.step ===
                        "reference"
                    ) {

                        const reference =
                            String(
                                msg.text || ""
                            ).trim();

                        if (!reference) {

                            return bot.sendMessage(
                                msg.chat.id,
                                "❌ Reference is required."
                            );
                        }

                        const user =
                            getUser(tid);

                        if (!user) {

                            return bot.sendMessage(
                                msg.chat.id,

                                "❌ User not found. Please send /start."
                            );
                        }

                        const amount =
                            num(
                                deposit.amount
                            );

                        if (
                            amount <
                            MIN_DEPOSIT
                        ) {

                            depositStates.delete(
                                tid
                            );

                            return bot.sendMessage(
                                msg.chat.id,

                                "❌ Invalid deposit amount."
                            );
                        }

                        /*
                            Prevent duplicate reference.
                        */

                        const existing =
                            db.prepare(`
                                SELECT id
                                FROM deposits
                                WHERE reference = ?
                                LIMIT 1
                            `).get(
                                reference
                            );

                        if (existing) {

                            depositStates.delete(
                                tid
                            );

                            return bot.sendMessage(
                                msg.chat.id,

                                `❌ This payment reference has already been submitted.

Deposit #${existing.id}`
                            );
                        }

                        const result =
                            db.prepare(`
                                INSERT INTO deposits (
                                    user_id,
                                    amount,
                                    reference,
                                    status
                                )
                                VALUES (
                                    ?,
                                    ?,
                                    ?,
                                    'pending'
                                )
                            `).run(
                                user.id,
                                amount,
                                reference
                            );

                        const depositId =
                            Number(
                                result.lastInsertRowid
                            );

                        depositStates.delete(
                            tid
                        );

                        await bot.sendMessage(
                            msg.chat.id,

                            `✅ Deposit submitted!

🆔 #${depositId}
💰 ${money(amount)} ETB
🧾 ${reference}
⏳ PENDING

After admin approval:

🎮 Play Wallet:
+${money(amount)} ETB

💵 Main Wallet:
No change`
                        );

                        /* Admin notification */

                        if (ADMIN_CHAT_ID) {

                            await bot.sendMessage(
                                ADMIN_CHAT_ID,

                                `💳 NEW DEPOSIT

🆔 #${depositId}
👤 User: ${tid}
💰 Amount: ${money(amount)} ETB
🧾 Reference: ${reference}`,

                                {
                                    reply_markup: {
                                        inline_keyboard: [
                                            [
                                                {
                                                    text:
                                                        "✅ Approve",

                                                    callback_data:
                                                        `approve_dep:${depositId}`
                                                },

                                                {
                                                    text:
                                                        "❌ Reject",

                                                    callback_data:
                                                        `reject_dep:${depositId}`
                                                }
                                            ]
                                        ]
                                    }
                                }
                            );
                        }

                        return;
                    }
                }

                /* =========================================
                   WITHDRAWAL
                ========================================= */

                const withdrawal =
                    withdrawStates.get(tid);

                if (withdrawal) {

                    /* -------------------------------------
                       WITHDRAW AMOUNT
                    ------------------------------------- */

                    if (
                        withdrawal.step ===
                        "amount"
                    ) {

                        const amount =
                            num(
                                msg.text.trim()
                            );

                        const user =
                            getUser(tid);

                        if (
                            amount <
                            MIN_WITHDRAW
                        ) {

                            return bot.sendMessage(
                                msg.chat.id,

                                `❌ Minimum withdrawal is ${MIN_WITHDRAW} ETB.`
                            );
                        }

                        if (
                            !user ||
                            Number(user.balance) <
                            amount
                        ) {

                            return bot.sendMessage(
                                msg.chat.id,

                                `❌ Insufficient Main Wallet.

💵 Main Wallet:
${money(
    user?.balance || 0
)} ETB`
                            );
                        }

                        withdrawal.amount =
                            amount;

                        withdrawal.step =
                            "account";

                        withdrawStates.set(
                            tid,
                            withdrawal
                        );

                        return bot.sendMessage(
                            msg.chat.id,

                            `💰 Amount:
${money(amount)} ETB

🏦 Now send your Telebirr/bank account details.`
                        );
                    }

                    /* -------------------------------------
                       ACCOUNT DETAILS
                    ------------------------------------- */

                    if (
                        withdrawal.step ===
                        "account"
                    ) {

                        const details =
                            String(
                                msg.text || ""
                            ).trim();

                        if (!details) {

                            return bot.sendMessage(
                                msg.chat.id,

                                "❌ Account details are required."
                            );
                        }

                        const user =
                            getUser(tid);

                        if (!user) {

                            withdrawStates.delete(
                                tid
                            );

                            return bot.sendMessage(
                                msg.chat.id,

                                "❌ User not found."
                            );
                        }

                        const amount =
                            num(
                                withdrawal.amount
                            );

                        if (
                            amount <
                            MIN_WITHDRAW
                        ) {

                            withdrawStates.delete(
                                tid
                            );

                            return bot.sendMessage(
                                msg.chat.id,

                                "❌ Invalid withdrawal amount."
                            );
                        }

                        /*
                            Withdrawal is reserved
                            from MAIN wallet only.

                            If INSERT fails,
                            transaction rolls back.
                        */

                        const withdrawalId =
                            db.transaction(() => {

                                const update =
                                    db.prepare(`
                                        UPDATE users
                                        SET balance =
                                            balance - ?

                                        WHERE
                                            id = ?

                                            AND balance >= ?
                                    `).run(
                                        amount,
                                        user.id,
                                        amount
                                    );

                                if (
                                    update.changes !== 1
                                ) {

                                    throw new Error(
                                        "Insufficient Main Wallet."
                                    );
                                }

                                const insert =
                                    db.prepare(`
                                        INSERT INTO withdrawals (
                                            user_id,
                                            telegram_id,
                                            amount,
                                            account_details,
                                            status
                                        )
                                        VALUES (
                                            ?,
                                            ?,
                                            ?,
                                            ?,
                                            'pending'
                                        )
                                    `).run(
                                        user.id,
                                        tid,
                                        amount,
                                        details
                                    );

                                return Number(
                                    insert.lastInsertRowid
                                );

                            })();

                        withdrawStates.delete(
                            tid
                        );

                        const fresh =
                            getUser(tid);

                        await bot.sendMessage(
                            msg.chat.id,

                            `✅ Withdrawal submitted!

🆔 #${withdrawalId}
💸 ${money(amount)} ETB
⏳ PENDING

💵 Remaining Main Wallet:
${money(fresh.balance)} ETB

🎮 Play Wallet:
${money(fresh.play_balance)} ETB`
                        );

                        /* Admin */

                        if (ADMIN_CHAT_ID) {

                            await bot.sendMessage(
                                ADMIN_CHAT_ID,

                                `💸 NEW WITHDRAWAL

🆔 #${withdrawalId}
👤 User: ${tid}
💰 Amount: ${money(amount)} ETB

🏦 Account:
${details}`,

                                {
                                    reply_markup: {
                                        inline_keyboard: [
                                            [
                                                {
                                                    text:
                                                        "✅ Approve",

                                                    callback_data:
                                                        `approve_wd:${withdrawalId}`
                                                },

                                                {
                                                    text:
                                                        "❌ Reject",

                                                    callback_data:
                                                        `reject_wd:${withdrawalId}`
                                                }
                                            ]
                                        ]
                                    }
                                }
                            );
                        }

                        return;
                    }
                }

            } catch (error) {

                console.error(
                    "Message handler:",
                    error
                );

                try {

                    await bot.sendMessage(
                        msg.chat.id,

                        `❌ Operation failed.

${error.message}`
                    );

                } catch (_) {}
            }
        }
    );

    /* =====================================================
       CALLBACK QUERIES
    ===================================================== */

    bot.on(
        "callback_query",
        async query => {

            const action =
                String(
                    query.data || ""
                );

            const chatId =
                query.message?.chat?.id;

            try {

                /* =========================================
                   REGISTER
                ========================================= */

                if (
                    action === "register"
                ) {

                    const user =
                        getOrCreateUser(
                            query.from
                        );

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    return bot.sendMessage(
                        chatId,

                        `✅ Registered!

👤 ${user.first_name || ""}

🆔 ${user.telegram_id}

💵 Main Wallet:
${money(user.balance)} ETB

🎮 Play Wallet:
${money(user.play_balance)} ETB`
                    );
                }

                /* =========================================
                   BALANCE
                ========================================= */

                if (
                    action === "balance"
                ) {

                    const user =
                        getOrCreateUser(
                            query.from
                        );

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    return bot.sendMessage(
                        chatId,

                        `💰 BALANCE

💵 Main:
${money(user.balance)} ETB

🎮 Play:
${money(user.play_balance)} ETB

💰 Total:
${money(
    Number(user.balance) +
    Number(user.play_balance)
)} ETB`
                    );
                }

                /* =========================================
                   DEPOSIT BUTTON
                ========================================= */

                if (
                    action === "deposit"
                ) {

                    getOrCreateUser(
                        query.from
                    );

                    depositStates.set(
                        String(
                            query.from.id
                        ),
                        {
                            step:
                                "amount"
                        }
                    );

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    return bot.sendMessage(
                        chatId,

                        `💳 DEPOSIT

Send amount in ETB.

Minimum:
${MIN_DEPOSIT} ETB

Payment address:
${PAYMENT_ADDRESS || "Not configured"}

⚠️ Approved deposits go to PLAY WALLET.`
                    );
                }

                /* =========================================
                   WITHDRAW BUTTON
                ========================================= */

                if (
                    action === "withdraw"
                ) {

                    const user =
                        getOrCreateUser(
                            query.from
                        );

                    if (
                        Number(user.balance) <
                        MIN_WITHDRAW
                    ) {

                        return bot.answerCallbackQuery(
                            query.id,

                            {
                                text:
                                    `Main Wallet must have at least ${MIN_WITHDRAW} ETB.`,

                                show_alert:
                                    true
                            }
                        );
                    }

                    withdrawStates.set(
                        String(
                            query.from.id
                        ),
                        {
                            step:
                                "amount"
                        }
                    );

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    return bot.sendMessage(
                        chatId,

                        `💸 WITHDRAW

Only your MAIN WALLET can be withdrawn.

Send withdrawal amount.

Minimum:
${MIN_WITHDRAW} ETB`
                    );
                }

                /* =========================================
                   GAMES
                ========================================= */

                if (
                    action === "games"
                ) {

                    const user =
                        getOrCreateUser(
                            query.from
                        );

                    const games =
                        db.prepare(`
                            SELECT
                                id,
                                result,
                                stake,
                                cards,
                                prize,
                                status
                            FROM games
                            WHERE user_id = ?
                            ORDER BY id DESC
                            LIMIT 10
                        `).all(user.id);

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    if (!games.length) {

                        return bot.sendMessage(
                            chatId,
                            "🎮 No games yet."
                        );
                    }

                    let text =
                        "🎮 Recent Games\n\n";

                    for (
                        const game of games
                    ) {

                        text +=
                            `#${game.id} • ` +
                            `${game.result || game.status} • ` +
                            `Stake: ${money(
                                game.stake *
                                game.cards
                            )} ETB • ` +
                            `Prize: ${money(
                                game.prize
                            )} ETB\n`;
                    }

                    return bot.sendMessage(
                        chatId,
                        text
                    );
                }

                /* =========================================
                   ADMIN SECURITY
                ========================================= */

                const isAdmin =
                    ADMIN_CHAT_ID &&
                    String(chatId) ===
                    String(ADMIN_CHAT_ID);

                /* =========================================
                   APPROVE DEPOSIT
                ========================================= */

                if (
                    action.startsWith(
                        "approve_dep:"
                    )
                ) {

                    if (!isAdmin) {

                        return bot.answerCallbackQuery(
                            query.id,

                            {
                                text:
                                    "Not authorized.",

                                show_alert:
                                    true
                            }
                        );
                    }

                    const id =
                        Number(
                            action.split(":")[1]
                        );

                    if (
                        !Number.isInteger(id) ||
                        id < 1
                    ) {

                        return bot.answerCallbackQuery(
                            query.id,

                            {
                                text:
                                    "Invalid deposit ID.",

                                show_alert:
                                    true
                            }
                        );
                    }

                    const result =
                        db.transaction(() => {

                            const deposit =
                                db.prepare(`
                                    SELECT
                                        d.*,
                                        u.telegram_id
                                    FROM deposits d
                                    JOIN users u
                                        ON u.id =
                                           d.user_id
                                    WHERE d.id = ?
                                `).get(id);

                            if (!deposit) {

                                throw new Error(
                                    "Deposit not found."
                                );
                            }

                            if (
                                deposit.status !==
                                "pending"
                            ) {

                                throw new Error(
                                    `Deposit #${id} is already ${deposit.status}.`
                                );
                            }

                            const amount =
                                num(
                                    deposit.amount
                                );

                            if (
                                amount <
                                MIN_DEPOSIT
                            ) {

                                throw new Error(
                                    "Invalid deposit amount."
                                );
                            }

                            /*
                                Mark approved FIRST
                                inside same transaction.
                            */

                            const update =
                                db.prepare(`
                                    UPDATE deposits
                                    SET
                                        status =
                                            'approved',

                                        approved_at =
                                            CURRENT_TIMESTAMP

                                    WHERE
                                        id = ?

                                        AND status =
                                            'pending'
                                `).run(id);

                            if (
                                update.changes !== 1
                            ) {

                                throw new Error(
                                    "Deposit was already processed."
                                );
                            }

                            /*
                                IMPORTANT:

                                DEPOSIT GOES TO
                                PLAY WALLET ONLY.
                            */

                            const balance =
                                db.prepare(`
                                    UPDATE users
                                    SET play_balance =
                                        play_balance + ?

                                    WHERE id = ?
                                `).run(
                                    amount,
                                    deposit.user_id
                                );

                            if (
                                balance.changes !== 1
                            ) {

                                throw new Error(
                                    "Play Wallet update failed."
                                );
                            }

                            return {
                                telegramId:
                                    String(
                                        deposit.telegram_id
                                    ),

                                amount
                            };

                        })();

                    const fresh =
                        getUser(
                            result.telegramId
                        );

                    await bot.answerCallbackQuery(
                        query.id,

                        {
                            text:
                                "Deposit approved ✅"
                        }
                    );

                    await bot.sendMessage(
                        chatId,

                        `✅ DEPOSIT APPROVED

🆔 #${id}
👤 ${result.telegramId}
💰 +${money(result.amount)} ETB

🎮 New Play Wallet:
${money(fresh.play_balance)} ETB

💵 Main Wallet:
${money(fresh.balance)} ETB`
                    );

                    try {

                        await bot.sendMessage(
                            result.telegramId,

                            `🎉 Deposit Approved!

💰 +${money(result.amount)} ETB

🎮 Play Wallet:
${money(fresh.play_balance)} ETB

💵 Main Wallet:
${money(fresh.balance)} ETB

⚠️ Deposit money is added to Play Wallet.`
                        );

                    } catch (_) {}

                    return;
                }

                /* =========================================
                   REJECT DEPOSIT
                ========================================= */

                if (
                    action.startsWith(
                        "reject_dep:"
                    )
                ) {

                    if (!isAdmin) {

                        return bot.answerCallbackQuery(
                            query.id,

                            {
                                text:
                                    "Not authorized.",

                                show_alert:
                                    true
                            }
                        );
                    }

                    const id =
                        Number(
                            action.split(":")[1]
                        );

                    const result =
                        db.transaction(() => {

                            const deposit =
                                db.prepare(`
                                    SELECT
                                        d.*,
                                        u.telegram_id
                                    FROM deposits d
                                    JOIN users u
                                        ON u.id =
                                           d.user_id
                                    WHERE d.id = ?
                                `).get(id);

                            if (!deposit) {

                                throw new Error(
                                    "Deposit not found."
                                );
                            }

                            if (
                                deposit.status !==
                                "pending"
                            ) {

                                throw new Error(
                                    "Deposit already processed."
                                );
                            }

                            const update =
                                db.prepare(`
                                    UPDATE deposits
                                    SET status =
                                        'rejected'

                                    WHERE
                                        id = ?

                                        AND status =
                                            'pending'
                                `).run(id);

                            if (
                                update.changes !== 1
                            ) {

                                throw new Error(
                                    "Deposit already processed."
                                );
                            }

                            return deposit;

                        })();

                    await bot.answerCallbackQuery(
                        query.id,

                        {
                            text:
                                "Deposit rejected ❌"
                        }
                    );

                    await bot.sendMessage(
                        chatId,

                        `❌ DEPOSIT REJECTED

🆔 #${id}
💰 ${money(result.amount)} ETB`
                    );

                    try {

                        await bot.sendMessage(
                            result.telegram_id,

                            `❌ Deposit Rejected

🆔 #${id}

💰 ${money(result.amount)} ETB was not added to your wallet.`
                        );

                    } catch (_) {}

                    return;
                }

                /* =========================================
                   APPROVE WITHDRAWAL
                ========================================= */

                if (
                    action.startsWith(
                        "approve_wd:"
                    )
                ) {

                    if (!isAdmin) {

                        return bot.answerCallbackQuery(
                            query.id,

                            {
                                text:
                                    "Not authorized.",

                                show_alert:
                                    true
                            }
                        );
                    }

                    const id =
                        Number(
                            action.split(":")[1]
                        );

                    const result =
                        db.transaction(() => {

                            const withdrawal =
                                db.prepare(`
                                    SELECT
                                        w.*,
                                        u.telegram_id
                                    FROM withdrawals w
                                    JOIN users u
                                        ON u.id =
                                           w.user_id
                                    WHERE w.id = ?
                                `).get(id);

                            if (!withdrawal) {

                                throw new Error(
                                    "Withdrawal not found."
                                );
                            }

                            if (
                                withdrawal.status !==
                                "pending"
                            ) {

                                throw new Error(
                                    `Withdrawal #${id} is already ${withdrawal.status}.`
                                );
                            }

                            /*
                                Money was already deducted
                                when the withdrawal was requested.

                                Approval DOES NOT deduct again.
                            */

                            const update =
                                db.prepare(`
                                    UPDATE withdrawals
                                    SET
                                        status =
                                            'approved',

                                        approved_at =
                                            CURRENT_TIMESTAMP

                                    WHERE
                                        id = ?

                                        AND status =
                                            'pending'
                                `).run(id);

                            if (
                                update.changes !== 1
                            ) {

                                throw new Error(
                                    "Withdrawal already processed."
                                );
                            }

                            return withdrawal;

                        })();

                    const fresh =
                        getUser(
                            result.telegram_id
                        );

                    await bot.answerCallbackQuery(
                        query.id,

                        {
                            text:
                                "Withdrawal approved ✅"
                        }
                    );

                    await bot.sendMessage(
                        chatId,

                        `✅ WITHDRAWAL APPROVED

🆔 #${id}
👤 ${result.telegram_id}
💸 ${money(result.amount)} ETB

💵 Remaining Main Wallet:
${money(fresh.balance)} ETB`
                    );

                    try {

                        await bot.sendMessage(
                            result.telegram_id,

                            `🎉 Withdrawal Approved!

🆔 #${id}

💸 ${money(result.amount)} ETB

Your withdrawal has been approved.

💵 Main Wallet:
${money(fresh.balance)} ETB`
                        );

                    } catch (_) {}

                    return;
                }

                /* =========================================
                   REJECT WITHDRAWAL
                ========================================= */

                if (
                    action.startsWith(
                        "reject_wd:"
                    )
                ) {

                    if (!isAdmin) {

                        return bot.answerCallbackQuery(
                            query.id,

                            {
                                text:
                                    "Not authorized.",

                                show_alert:
                                    true
                            }
                        );
                    }

                    const id =
                        Number(
                            action.split(":")[1]
                        );

                    const result =
                        db.transaction(() => {

                            const withdrawal =
                                db.prepare(`
                                    SELECT
                                        w.*,
                                        u.telegram_id
                                    FROM withdrawals w
                                    JOIN users u
                                        ON u.id =
                                           w.user_id
                                    WHERE w.id = ?
                                `).get(id);

                            if (!withdrawal) {

                                throw new Error(
                                    "Withdrawal not found."
                                );
                            }

                            if (
                                withdrawal.status !==
                                "pending"
                            ) {

                                throw new Error(
                                    "Withdrawal already processed."
                                );
                            }

                            const update =
                                db.prepare(`
                                    UPDATE withdrawals
                                    SET status =
                                        'rejected'

                                    WHERE
                                        id = ?

                                        AND status =
                                            'pending'
                                `).run(id);

                            if (
                                update.changes !== 1
                            ) {

                                throw new Error(
                                    "Withdrawal already processed."
                                );
                            }

                            /*
                                Return the money to MAIN wallet.
                            */

                            const refund =
                                db.prepare(`
                                    UPDATE users
                                    SET balance =
                                        balance + ?

                                    WHERE id = ?
                                `).run(
                                    num(
                                        withdrawal.amount
                                    ),
                                    withdrawal.user_id
                                );

                            if (
                                refund.changes !== 1
                            ) {

                                throw new Error(
                                    "Could not refund withdrawal."
                                );
                            }

                            return withdrawal;

                        })();

                    const fresh =
                        getUser(
                            result.telegram_id
                        );

                    await bot.answerCallbackQuery(
                        query.id,

                        {
                            text:
                                "Withdrawal rejected ❌"
                        }
                    );

                    await bot.sendMessage(
                        chatId,

                        `❌ WITHDRAWAL REJECTED

🆔 #${id}

💰 ${money(result.amount)} ETB returned to Main Wallet.`
                    );

                    try {

                        await bot.sendMessage(
                            result.telegram_id,

                            `❌ Withdrawal Rejected

🆔 #${id}

💰 ${money(result.amount)} ETB returned.

💵 Main Wallet:
${money(fresh.balance)} ETB

🎮 Play Wallet:
${money(fresh.play_balance)} ETB`
                        );

                    } catch (_) {}

                    return;
                }

                /* =========================================
                   UNKNOWN CALLBACK
                ========================================= */

                await bot.answerCallbackQuery(
                    query.id
                );

            } catch (error) {

                console.error(
                    "Callback error:",
                    error
                );

                try {

                    await bot.answerCallbackQuery(
                        query.id,

                        {
                            text:
                                error.message ||
                                "Operation failed.",

                            show_alert:
                                true
                        }
                    );

                } catch (_) {}
            }
        }
    );

    /* =====================================================
       TELEGRAM POLLING ERROR
    ===================================================== */

    bot.on(
        "polling_error",
        error => {

            console.error(
                "Telegram polling error:",
                error.message
            );
        }
    );

} else {

    console.error(
        "❌ BOT_TOKEN is missing in .env"
    );
}

/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "===================================="
        );

        console.log(
            "🎱 FRICK BINGO SERVER"
        );

        console.log(
            `🚀 Server running on port ${PORT}`
        );

        console.log(
            `🌐 Web App: ${
                WEB_APP_URL ||
                "Not configured"
            }`
        );

        console.log(
            `👑 Admin: ${
                ADMIN_CHAT_ID ||
                "Not configured"
            }`
        );

        console.log(
            "💰 Balance API: /api/balance"
        );

        console.log(
            "💳 Deposit → PLAY WALLET"
        );

        console.log(
            "🎮 Game → PLAY first, MAIN second"
        );

        console.log(
            "🏆 Win → MAIN WALLET"
        );

        console.log(
            "💸 Withdrawal → MAIN WALLET ONLY"
        );

        console.log(
            "===================================="
        );
    }
);
