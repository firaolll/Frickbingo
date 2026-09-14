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

const BOT_TOKEN = String(
    process.env.BOT_TOKEN || ""
).trim();

const WEB_APP_URL = String(
    process.env.WEB_APP_URL || ""
).trim();

const ADMIN_CHAT_ID = String(
    process.env.ADMIN_CHAT_ID || ""
).trim();

const PAYMENT_ADDRESS = String(
    process.env.PAYMENT_ADDRESS || ""
).trim();

const DATABASE_FILE = String(
    process.env.DATABASE_FILE || "frickbingo.db"
).trim();

const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;

const GAME_STAKES = [10, 20];
const MAX_CARDS = 2;

const WIN_RATE = 0.85;

/*
   Players should normally join the same match during
   the card-selection/countdown period.
*/
const MATCH_WAIT_SECONDS = 35;

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

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
        FOREIGN KEY (user_id)
            REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        account_details TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        FOREIGN KEY (user_id)
            REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        stake REAL NOT NULL,

        status TEXT NOT NULL
            DEFAULT 'WAITING',

        prize_pool REAL NOT NULL
            DEFAULT 0,

        winner_count INTEGER NOT NULL
            DEFAULT 0,

        paid INTEGER NOT NULL
            DEFAULT 0,

        created_at DATETIME
            DEFAULT CURRENT_TIMESTAMP,

        started_at DATETIME,

        finished_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        user_id INTEGER NOT NULL,

        match_id INTEGER,

        stake REAL NOT NULL,

        cards INTEGER NOT NULL,

        result TEXT DEFAULT 'STARTED',

        prize REAL NOT NULL DEFAULT 0,

        card_number INTEGER,

        status TEXT NOT NULL
            DEFAULT 'STARTED',

        play_spent REAL NOT NULL
            DEFAULT 0,

        main_spent REAL NOT NULL
            DEFAULT 0,

        created_at DATETIME
            DEFAULT CURRENT_TIMESTAMP,

        finished_at DATETIME,

        FOREIGN KEY (user_id)
            REFERENCES users(id),

        FOREIGN KEY (match_id)
            REFERENCES matches(id)
    );
`);

/* =========================================================
   SAFE MIGRATION
========================================================= */

function columnExists(
    tableName,
    columnName
) {
    const columns = db
        .prepare(
            `PRAGMA table_info(${tableName})`
        )
        .all();

    return columns.some(
        column =>
            column.name === columnName
    );
}

function addColumnIfMissing(
    tableName,
    columnName,
    definition
) {
    if (!columnExists(
        tableName,
        columnName
    )) {

        try {

            db.prepare(
                `ALTER TABLE ${tableName}
                 ADD COLUMN ${columnName}
                 ${definition}`
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
    "games",
    "match_id",
    "INTEGER"
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

function getMatch(matchId) {

    return db
        .prepare(`
            SELECT *
            FROM matches
            WHERE id = ?
        `)
        .get(Number(matchId));
}

function getOrCreateUser(from) {

    if (!from || from.id == null) {

        throw new Error(
            "Telegram user ID missing."
        );
    }

    const telegramId =
        String(from.id);

    const username =
        from.username
            ? String(from.username)
            : "";

    const firstName =
        from.first_name
            ? String(from.first_name)
            : "";

    let user =
        getUser(telegramId);

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

function validateInitData(
    initData
) {

    if (
        !initData ||
        !BOT_TOKEN
    ) {
        return null;
    }

    try {

        const params =
            new URLSearchParams(
                initData
            );

        const receivedHash =
            params.get("hash");

        if (!receivedHash) {
            return null;
        }

        params.delete("hash");

        const dataCheckString =
            [...params.entries()]
                .sort(
                    ([a], [b]) =>
                        a.localeCompare(b)
                )
                .map(
                    ([key, value]) =>
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
                .update(
                    dataCheckString
                )
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
            !crypto.timingSafeEqual(
                a,
                b
            )
        ) {
            return null;
        }

        const userData =
            params.get("user");

        if (!userData) {
            return null;
        }

        return JSON.parse(
            userData
        );

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

function auth(
    req,
    res,
    next
) {

    try {

        const initData =
            req.headers[
                "x-telegram-init-data"
            ] || "";

        const telegramUser =
            validateInitData(
                initData
            );

        if (
            !telegramUser ||
            telegramUser.id == null
        ) {

            return res.status(401)
                .json({
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

        return res.status(401)
            .json({
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
            time:
                new Date().toISOString()
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
                    String(
                        user.telegram_id
                    ),

                username:
                    user.username || "",

                firstName:
                    user.first_name || "",

                mainBalance:
                    num(
                        user.balance
                    ),

                playBalance:
                    num(
                        user.play_balance
                    )
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
                num(
                    user.play_balance
                ),

            totalBalance:
                num(
                    Number(
                        user.balance
                    ) +
                    Number(
                        user.play_balance
                    )
                )
        });
    }
);

/* =========================================================
   MATCH CREATE
========================================================= */

/*
   Create a new Bingo match.

   The frontend should call this when the card-selection
   countdown begins.
*/

app.post(
    "/api/match/create",
    auth,
    (req, res) => {

        try {

            const stake =
                Number(
                    req.body?.stake
                );

            if (
                !GAME_STAKES.includes(
                    stake
                )
            ) {

                return res.status(400)
                    .json({
                        ok: false,
                        error:
                            "Invalid stake."
                    });
            }

            const match =
                db.prepare(`
                    INSERT INTO matches (
                        stake,
                        status,
                        prize_pool,
                        winner_count,
                        paid
                    )
                    VALUES (
                        ?,
                        'WAITING',
                        0,
                        0,
                        0
                    )
                `).run(stake);

            const matchId =
                Number(
                    match.lastInsertRowid
                );

            res.json({

                ok: true,

                matchId,

                stake,

                countdown:
                    MATCH_WAIT_SECONDS
            });

        } catch (error) {

            console.error(
                "Match create:",
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
   MATCH INFO
========================================================= */

app.get(
    "/api/match/:matchId",
    auth,
    (req, res) => {

        try {

            const matchId =
                Number(
                    req.params.matchId
                );

            if (
                !Number.isInteger(
                    matchId
                ) ||
                matchId < 1
            ) {

                return res.status(400)
                    .json({
                        ok: false,
                        error:
                            "Invalid match ID."
                    });
            }

            const match =
                getMatch(matchId);

            if (!match) {

                return res.status(404)
                    .json({
                        ok: false,
                        error:
                            "Match not found."
                    });
            }

            const players =
                db.prepare(`
                    SELECT
                        games.id,
                        games.user_id,
                        games.stake,
                        games.cards,
                        games.status,
                        games.result
                    FROM games
                    WHERE
                        games.match_id = ?
                    ORDER BY games.id ASC
                `).all(matchId);

            res.json({

                ok: true,

                match: {

                    id:
                        match.id,

                    stake:
                        num(match.stake),

                    status:
                        match.status,

                    playerCount:
                        players.length,

                    prizePool:
                        num(match.prize_pool),

                    winnerCount:
                        match.winner_count,

                    paid:
                        Boolean(match.paid)
                },

                players
            });

        } catch (error) {

            console.error(
                "Match info:",
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
   MATCH JOIN
========================================================= */

app.post(
    "/api/match/join",
    auth,
    (req, res) => {

        try {

            const matchId =
                Number(
                    req.body?.matchId
                );

            const cards =
                Number(
                    req.body?.cards
                );

            if (
                !Number.isInteger(
                    matchId
                ) ||
                matchId < 1
            ) {

                return res.status(400)
                    .json({
                        ok: false,
                        error:
                            "Invalid match ID."
                    });
            }

            if (
                !Number.isInteger(
                    cards
                ) ||
                cards < 1 ||
                cards > MAX_CARDS
            ) {

                return res.status(400)
                    .json({
                        ok: false,
                        error:
                            "Cards must be 1 or 2."
                    });
            }

            const output =
                db.transaction(() => {

                    const match =
                        getMatch(
                            matchId
                        );

                    if (!match) {

                        throw new Error(
                            "Match not found."
                        );
                    }

                    if (
                        match.status !==
                        "WAITING"
                    ) {

                        throw new Error(
                            "Match is no longer accepting players."
                        );
                    }

                    const existing =
                        db.prepare(`
                            SELECT *
                            FROM games
                            WHERE
                                match_id = ?
                                AND user_id = ?
                                AND status != 'CANCELLED'
                        `).get(
                            matchId,
                            req.user.id
                        );

                    if (existing) {

                        return {
                            gameId:
                                existing.id,

                            cost:
                                num(
                                    existing.stake *
                                    existing.cards
                                ),

                            playSpent:
                                num(
                                    existing.play_spent
                                ),

                            mainSpent:
                                num(
                                    existing.main_spent
                                )
                        };
                    }

                    const cost =
                        num(
                            match.stake *
                            cards
                        );

                    const user =
                        getUserById(
                            req.user.id
                        );

                    const main =
                        num(
                            user.balance
                        );

                    const play =
                        num(
                            user.play_balance
                        );

                    const total =
                        num(
                            main + play
                        );

                    if (total < cost) {

                        throw new Error(
                            `Insufficient balance. ` +
                            `You need ${money(cost)} ETB. ` +
                            `Main: ${money(main)} ETB, ` +
                            `Play: ${money(play)} ETB.`
                        );
                    }

                    /*
                       PLAY WALLET IS SPENT FIRST.
                    */

                    const playSpent =
                        num(
                            Math.min(
                                play,
                                cost
                            )
                        );

                    const mainSpent =
                        num(
                            cost -
                            playSpent
                        );

                    const balanceUpdate =
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
                        balanceUpdate.changes !== 1
                    ) {

                        throw new Error(
                            "Balance changed. Please try again."
                        );
                    }

                    const game =
                        db.prepare(`
                            INSERT INTO games (
                                user_id,
                                match_id,
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
                                ?,
                                'STARTED',
                                0,
                                'STARTED',
                                ?,
                                ?
                            )
                        `).run(
                            user.id,
                            matchId,
                            match.stake,
                            cards,
                            playSpent,
                            mainSpent
                        );

                    /*
                       As soon as a player joins,
                       match becomes ACTIVE.
                    */

                    db.prepare(`
                        UPDATE matches
                        SET
                            status = 'ACTIVE',
                            started_at =
                                COALESCE(
                                    started_at,
                                    CURRENT_TIMESTAMP
                                )
                        WHERE
                            id = ?
                            AND status = 'WAITING'
                    `).run(matchId);

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

                matchId,

                gameId:
                    output.gameId,

                cost:
                    output.cost,

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
                "Match join:",
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
   GAME START
========================================================= */

/*
   Compatibility endpoint.

   New frontend:
       send matchId.

   Old frontend:
       no matchId.

   If no matchId is supplied, this endpoint creates a
   private match for that game so the existing frontend
   does not crash.
*/

app.post(
    "/api/game/start",
    auth,
    (req, res) => {

        try {

            const stake =
                Number(
                    req.body?.stake
                );

            const cards =
                Number(
                    req.body?.cards
                );

            let matchId =
                req.body?.matchId == null
                    ? null
                    : Number(
                        req.body.matchId
                    );

            if (
                !GAME_STAKES.includes(
                    stake
                )
            ) {

                return res.status(400)
                    .json({
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

                return res.status(400)
                    .json({
                        ok: false,
                        error:
                            "Cards must be 1 or 2."
                    });
            }

            const result =
                db.transaction(() => {

                    /*
                       If frontend does not send a match,
                       create one automatically.
                    */

                    if (
                        !Number.isInteger(
                            matchId
                        ) ||
                        matchId < 1
                    ) {

                        const match =
                            db.prepare(`
                                INSERT INTO matches (
                                    stake,
                                    status,
                                    prize_pool,
                                    winner_count,
                                    paid
                                )
                                VALUES (
                                    ?,
                                    'ACTIVE',
                                    0,
                                    0,
                                    0
                                )
                            `).run(
                                stake
                            );

                        matchId =
                            Number(
                                match.lastInsertRowid
                            );

                    } else {

                        const match =
                            getMatch(
                                matchId
                            );

                        if (!match) {

                            throw new Error(
                                "Match not found."
                            );
                        }

                        if (
                            Number(
                                match.stake
                            ) !== stake
                        ) {

                            throw new Error(
                                "Stake does not match the Bingo match."
                            );
                        }

                        if (
                            match.status ===
                            "FINISHED" ||
                            match.status ===
                            "PAID"
                        ) {

                            throw new Error(
                                "Match already finished."
                            );
                        }
                    }

                    /*
                       Prevent same user from paying twice
                       into the same match.
                    */

                    const existing =
                        db.prepare(`
                            SELECT *
                            FROM games
                            WHERE
                                match_id = ?
                                AND user_id = ?
                        `).get(
                            matchId,
                            req.user.id
                        );

                    if (existing) {

                        return {

                            matchId,

                            gameId:
                                existing.id,

                            cost:
                                num(
                                    existing.stake *
                                    existing.cards
                                ),

                            playSpent:
                                num(
                                    existing.play_spent
                                ),

                            mainSpent:
                                num(
                                    existing.main_spent
                                )
                        };
                    }

                    const cost =
                        num(
                            stake * cards
                        );

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
                        num(
                            user.balance
                        );

                    const play =
                        num(
                            user.play_balance
                        );

                    const total =
                        num(
                            main + play
                        );

                    if (total < cost) {

                        throw new Error(
                            `Insufficient balance. ` +
                            `You need ${money(cost)} ETB. ` +
                            `Main: ${money(main)} ETB, ` +
                            `Play: ${money(play)} ETB.`
                        );
                    }

                    /*
                       PLAY FIRST.
                       MAIN SECOND.
                    */

                    const playSpent =
                        num(
                            Math.min(
                                play,
                                cost
                            )
                        );

                    const mainSpent =
                        num(
                            cost -
                            playSpent
                        );

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

                    const game =
                        db.prepare(`
                            INSERT INTO games (
                                user_id,
                                match_id,
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
                                ?,
                                'STARTED',
                                0,
                                'STARTED',
                                ?,
                                ?
                            )
                        `).run(
                            user.id,
                            matchId,
                            stake,
                            cards,
                            playSpent,
                            mainSpent
                        );

                    db.prepare(`
                        UPDATE matches
                        SET
                            status = 'ACTIVE',
                            started_at =
                                COALESCE(
                                    started_at,
                                    CURRENT_TIMESTAMP
                                )
                        WHERE id = ?
                    `).run(matchId);

                    return {

                        matchId,

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

                matchId:
                    result.matchId,

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
   MATCH PAYOUT
========================================================= */

/*
   IMPORTANT:

   The prize is NOT:

       player's cost × 85%

   It is:

       ALL PLAYER COSTS × 85%

   Example:

       Player A = 20
       Player B = 20

       Total = 40

       Prize pool = 40 × 0.85
                  = 34 ETB

   One winner:
       34 ETB

   Two winners:
       17 ETB each
*/

/*
   This function MUST be called inside a SQLite
   transaction.
*/

function finalizeMatchPayout(
    matchId
) {

    const match =
        getMatch(matchId);

    if (!match) {

        throw new Error(
            "Match not found."
        );
    }

    /*
       Already paid.
       Return previous payout information.
    */

    if (
        Number(match.paid) === 1
    ) {

        const winners =
            db.prepare(`
                SELECT
                    games.id,
                    games.user_id,
                    games.prize
                FROM games
                WHERE
                    games.match_id = ?
                    AND games.result = 'WIN'
            `).all(matchId);

        return {

            paid: true,

            totalCost:
                num(
                    winners.reduce(
                        (sum) => sum,
                        0
                    )
                ),

            totalPrize:
                num(
                    match.prize_pool
                ),

            winnerCount:
                Number(
                    match.winner_count
                ),

            alreadyPaid: true
        };
    }

    /*
       Get every game/player in this match.
    */

    const games =
        db.prepare(`
            SELECT *
            FROM games
            WHERE match_id = ?
            ORDER BY id ASC
        `).all(matchId);

    if (!games.length) {

        throw new Error(
            "No players in match."
        );
    }

    /*
       Do not pay until every player in this match
       has submitted WIN or LOSE.

       This is important because the server must know
       the complete winner list before dividing the prize.
    */

    const unfinished =
        games.filter(
            game =>
                game.status !==
                "FINISHED"
        );

    if (unfinished.length > 0) {

        return {

            paid: false,

            waiting: true,

            totalPlayers:
                games.length,

            finishedPlayers:
                games.length -
                unfinished.length
        };
    }

    /*
       TOTAL PLAYER COST
    */

    let totalCost = 0;

    for (const game of games) {

        totalCost =
            num(
                totalCost +
                num(
                    game.stake *
                    game.cards
                )
            );
    }

    /*
       85% OF TOTAL PLAYER COST
    */

    const totalPrize =
        num(
            totalCost *
            WIN_RATE
        );

    /*
       ALL WINNERS
    */

    const winners =
        games.filter(
            game =>
                String(
                    game.result
                ).toUpperCase() ===
                "WIN"
        );

    /*
       No winner.

       The 85% prize is not paid.
    */

    if (!winners.length) {

        db.prepare(`
            UPDATE matches
            SET
                prize_pool = 0,
                winner_count = 0,
                paid = 1,
                status = 'PAID',
                finished_at =
                    CURRENT_TIMESTAMP
            WHERE
                id = ?
                AND paid = 0
        `).run(matchId);

        return {

            paid: true,

            totalCost,

            totalPrize: 0,

            winnerCount: 0,

            winners: []
        };
    }

    /*
       DIVIDE TOTAL PRIZE BETWEEN ALL WINNERS.
    */

    const winnerCount =
        winners.length;

    /*
       Work in cents so that money rounding is
       deterministic.
    */

    const totalPrizeCents =
        Math.round(
            totalPrize * 100
        );

    const baseShareCents =
        Math.floor(
            totalPrizeCents /
            winnerCount
        );

    const remainderCents =
        totalPrizeCents %
        winnerCount;

    const payouts = [];

    /*
       If the prize cannot divide exactly into cents,
       the extra cents are assigned deterministically
       to the first winner(s).

       Example:

       10.00 / 3

       3.34
       3.33
       3.33

       Total = 10.00
    */

    for (
        let i = 0;
        i < winners.length;
        i++
    ) {

        const cents =
            baseShareCents +
            (
                i < remainderCents
                    ? 1
                    : 0
            );

        const share =
            num(
                cents / 100
            );

        const winner =
            winners[i];

        const update =
            db.prepare(`
                UPDATE users
                SET balance =
                    balance + ?
                WHERE id = ?
            `).run(
                share,
                winner.user_id
            );

        if (
            update.changes !== 1
        ) {

            throw new Error(
                `Prize balance update failed for user ${winner.user_id}.`
            );
        }

        db.prepare(`
            UPDATE games
            SET prize = ?
            WHERE id = ?
        `).run(
            share,
            winner.id
        );

        payouts.push({

            gameId:
                winner.id,

            userId:
                winner.user_id,

            prize:
                share
        });
    }

    /*
       Mark match paid LAST.

       Because everything is inside a SQLite transaction,
       another request cannot safely pay this match twice.
    */

    const matchUpdate =
        db.prepare(`
            UPDATE matches
            SET
                prize_pool = ?,
                winner_count = ?,
                paid = 1,
                status = 'PAID',
                finished_at =
                    CURRENT_TIMESTAMP
            WHERE
                id = ?
                AND paid = 0
        `).run(
            totalPrize,
            winnerCount,
            matchId
        );

    if (
        matchUpdate.changes !== 1
    ) {

        throw new Error(
            "Match payout was already processed."
        );
    }

    return {

        paid: true,

        totalCost,

        totalPrize,

        winnerCount,

        winners:
            payouts
    };
}

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

            const suppliedMatchId =
                req.body?.matchId == null
                    ? null
                    : Number(
                        req.body.matchId
                    );

            if (
                !Number.isInteger(
                    gameId
                ) ||
                gameId < 1
            ) {

                return res.status(400)
                    .json({
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

                return res.status(400)
                    .json({
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

                    const matchId =
                        Number(
                            game.match_id ||
                            suppliedMatchId
                        );

                    if (
                        !Number.isInteger(
                            matchId
                        ) ||
                        matchId < 1
                    ) {

                        throw new Error(
                            "Game is not connected to a Bingo match."
                        );
                    }

                    /*
                       Already finished?

                       Return current state instead of paying
                       again.
                    */

                    if (
                        game.status ===
                        "FINISHED"
                    ) {

                        const match =
                            getMatch(
                                matchId
                            );

                        return {

                            cost:
                                num(
                                    game.stake *
                                    game.cards
                                ),

                            prize:
                                num(
                                    game.prize
                                ),

                            playSpent:
                                num(
                                    game.play_spent
                                ),

                            mainSpent:
                                num(
                                    game.main_spent
                                ),

                            matchId,

                            alreadyFinished:
                                true,

                            matchPaid:
                                Boolean(
                                    match?.paid
                                )
                        };
                    }

                    /*
                       Mark this player's result first.
                    */

                    const gameUpdate =
                        db.prepare(`
                            UPDATE games
                            SET
                                result = ?,
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

                    /*
                       Check whether every player has
                       finished.
                    */

                    const matchGames =
                        db.prepare(`
                            SELECT *
                            FROM games
                            WHERE match_id = ?
                        `).all(
                            matchId
                        );

                    const allFinished =
                        matchGames.length > 0 &&
                        matchGames.every(
                            item =>
                                item.status ===
                                "FINISHED"
                        );

                    let payout = {

                        paid: false,

                        waiting: true
                    };

                    /*
                       Only calculate the prize when ALL
                       players have submitted their result.
                    */

                    if (allFinished) {

                        payout =
                            finalizeMatchPayout(
                                matchId
                            );
                    }

                    const updatedGame =
                        db.prepare(`
                            SELECT *
                            FROM games
                            WHERE id = ?
                        `).get(
                            gameId
                        );

                    return {

                        cost:
                            num(
                                game.stake *
                                game.cards
                            ),

                        prize:
                            num(
                                updatedGame.prize
                            ),

                        playSpent:
                            num(
                                game.play_spent
                            ),

                        mainSpent:
                            num(
                                game.main_spent
                            ),

                        matchId,

                        payout
                    };

                })();

            const fresh =
                getUserById(
                    req.user.id
                );

            res.json({

                ok: true,

                matchId:
                    output.matchId,

                cost:
                    output.cost,

                prize:
                    output.prize,

                playSpent:
                    output.playSpent,

                mainSpent:
                    output.mainSpent,

                payout:
                    output.payout,

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
                    match_id,
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
   BOT START
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
       /START
    ===================================================== */

    bot.onText(
        /^\/start$/,
        async msg => {

            try {

                getOrCreateUser(
                    msg.from
                );

                await bot.sendMessage(
                    msg.chat.id,

                    `🎱 Welcome to Frick Bingo!

Play Bingo and win prizes.

💰 Deposit
🎮 Play
💸 Withdraw
📊 Check your balance

Choose an option below:`,

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
       /REGISTER
    ===================================================== */

    bot.onText(
        /^\/register$/,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                await bot.sendMessage(
                    msg.chat.id,

                    `✅ Registration successful!

👤 Name: ${
                        user.first_name ||
                        "Player"
                    }

🆔 Telegram ID: ${
                        user.telegram_id
                    }

🎱 You can now play Frick Bingo.`,

                    {
                        reply_markup:
                            keyboard()
                    }
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
       /BALANCE
    ===================================================== */

    bot.onText(
        /^\/balance$/,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                await bot.sendMessage(
                    msg.chat.id,

                    `💰 Your Balance

🏦 Main Wallet:
${money(user.balance)} ETB

🎮 Play Wallet:
${money(user.play_balance)} ETB

💵 Total:
${money(
    Number(user.balance) +
    Number(user.play_balance)
)} ETB`,

                    {
                        reply_markup:
                            keyboard()
                    }
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
       /PLAY
    ===================================================== */

    bot.onText(
        /^\/play$/,
        async msg => {

            try {

                getOrCreateUser(
                    msg.from
                );

                if (!WEB_APP_URL) {

                    await bot.sendMessage(
                        msg.chat.id,

                        "❌ Bingo Web App is not configured."
                    );

                    return;
                }

                await bot.sendMessage(
                    msg.chat.id,

                    "🎱 Tap below to open Frick Bingo.",

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

            } catch (error) {

                console.error(
                    "/play:",
                    error
                );
            }
        }
    );

    /* =====================================================
       /GAMES
    ===================================================== */

    bot.onText(
        /^\/games$/,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                const games =
                    db.prepare(`
                        SELECT
                            stake,
                            cards,
                            result,
                            prize,
                            created_at
                        FROM games
                        WHERE user_id = ?
                        ORDER BY id DESC
                        LIMIT 10
                    `).all(
                        user.id
                    );

                if (!games.length) {

                    await bot.sendMessage(
                        msg.chat.id,
                        "🎮 You have no games yet.",
                        {
                            reply_markup:
                                keyboard()
                        }
                    );

                    return;
                }

                let text =
                    "🎮 Recent Games\n\n";

                games.forEach(
                    (game, index) => {

                        text +=
                            `${index + 1}. ` +
                            `${game.result} | ` +
                            `Stake: ${money(game.stake)} | ` +
                            `Cards: ${game.cards} | ` +
                            `Prize: ${money(game.prize)} ETB\n`;
                    }
                );

                await bot.sendMessage(
                    msg.chat.id,
                    text,
                    {
                        reply_markup:
                            keyboard()
                    }
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
       /HELP
    ===================================================== */

    bot.onText(
        /^\/help$/,
        async msg => {

            await bot.sendMessage(
                msg.chat.id,

                `🎱 Frick Bingo Help

/start - Open Frick Bingo
/register - Register account
/balance - Check wallet
/deposit - Deposit money
/withdraw - Withdraw money
/play - Open Bingo
/games - Game history
/help - Show help`,

                {
                    reply_markup:
                        keyboard()
                }
            );
        }
    );

    /* =====================================================
       DEPOSIT COMMAND
    ===================================================== */

    bot.onText(
        /^\/deposit$/,
        async msg => {

            try {

                getOrCreateUser(
                    msg.from
                );

                depositStates.set(
                    String(msg.chat.id),
                    {
                        step:
                            "amount"
                    }
                );

                await bot.sendMessage(
                    msg.chat.id,

                    `💳 Deposit

Minimum deposit:
${MIN_DEPOSIT} ETB

Please enter the amount you want to deposit.`,

                    {
                        reply_markup: {
                            force_reply: true
                        }
                    }
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
       WITHDRAW COMMAND
    ===================================================== */

    bot.onText(
        /^\/withdraw$/,
        async msg => {

            try {

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                if (
                    Number(
                        user.balance
                    ) < MIN_WITHDRAW
                ) {

                    await bot.sendMessage(
                        msg.chat.id,

                        `❌ Minimum withdrawal is ${MIN_WITHDRAW} ETB.

Your Main Wallet:
${money(user.balance)} ETB`,

                        {
                            reply_markup:
                                keyboard()
                        }
                    );

                    return;
                }

                withdrawStates.set(
                    String(msg.chat.id),
                    {
                        step:
                            "amount"
                    }
                );

                await bot.sendMessage(
                    msg.chat.id,

                    `💸 Withdraw

Minimum withdrawal:
${MIN_WITHDRAW} ETB

Available Main Wallet:
${money(user.balance)} ETB

Enter withdrawal amount.`,

                    {
                        reply_markup: {
                            force_reply: true
                        }
                    }
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
       CALLBACK QUERIES
    ===================================================== */

    bot.on(
        "callback_query",
        async query => {

            try {

                const chatId =
                    query.message.chat.id;

                const user =
                    getOrCreateUser(
                        query.from
                    );

                const data =
                    String(
                        query.data || ""
                    );

                /* -----------------------------------------
                   REGISTER
                ----------------------------------------- */

                if (
                    data === "register"
                ) {

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    await bot.sendMessage(
                        chatId,

                        `✅ You are registered.

👤 ${
                            user.first_name ||
                            "Player"
                        }

🆔 ${
                            user.telegram_id
                        }`,

                        {
                            reply_markup:
                                keyboard()
                        }
                    );

                    return;
                }

                /* -----------------------------------------
                   BALANCE
                ----------------------------------------- */

                if (
                    data === "balance"
                ) {

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    await bot.sendMessage(
                        chatId,

                        `💰 Balance

🏦 Main Wallet:
${money(user.balance)} ETB

🎮 Play Wallet:
${money(user.play_balance)} ETB

💵 Total:
${money(
    Number(user.balance) +
    Number(user.play_balance)
)} ETB`,

                        {
                            reply_markup:
                                keyboard()
                        }
                    );

                    return;
                }

                /* -----------------------------------------
                   DEPOSIT
                ----------------------------------------- */

                if (
                    data === "deposit"
                ) {

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    depositStates.set(
                        String(chatId),
                        {
                            step:
                                "amount"
                        }
                    );

                    await bot.sendMessage(
                        chatId,

                        `💳 Deposit

Minimum:
${MIN_DEPOSIT} ETB

Enter deposit amount.`,

                        {
                            reply_markup: {
                                force_reply: true
                            }
                        }
                    );

                    return;
                }

                /* -----------------------------------------
                   WITHDRAW
                ----------------------------------------- */

                if (
                    data === "withdraw"
                ) {

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    const currentUser =
                        getUserById(
                            user.id
                        );

                    if (
                        Number(
                            currentUser.balance
                        ) < MIN_WITHDRAW
                    ) {

                        await bot.sendMessage(
                            chatId,

                            `❌ Minimum withdrawal is ${MIN_WITHDRAW} ETB.

Main Wallet:
${money(
    currentUser.balance
)} ETB`
                        );

                        return;
                    }

                    withdrawStates.set(
                        String(chatId),
                        {
                            step:
                                "amount"
                        }
                    );

                    await bot.sendMessage(
                        chatId,

                        `💸 Withdraw

Minimum:
${MIN_WITHDRAW} ETB

Main Wallet:
${money(
    currentUser.balance
)} ETB

Enter amount.`,

                        {
                            reply_markup: {
                                force_reply: true
                            }
                        }
                    );

                    return;
                }

                /* -----------------------------------------
                   GAMES
                ----------------------------------------- */

                if (
                    data === "games"
                ) {

                    await bot.answerCallbackQuery(
                        query.id
                    );

                    const games =
                        db.prepare(`
                            SELECT
                                stake,
                                cards,
                                result,
                                prize
                            FROM games
                            WHERE user_id = ?
                            ORDER BY id DESC
                            LIMIT 10
                        `).all(
                            user.id
                        );

                    if (!games.length) {

                        await bot.sendMessage(
                            chatId,
                            "🎮 No games yet.",
                            {
                                reply_markup:
                                    keyboard()
                            }
                        );

                        return;
                    }

                    let text =
                        "🎮 Recent Games\n\n";

                    games.forEach(
                        (game, index) => {

                            text +=
                                `${index + 1}. ` +
                                `${game.result} | ` +
                                `${money(game.stake)} ETB | ` +
                                `${game.cards} card(s) | ` +
                                `Prize ${money(game.prize)} ETB\n`;
                        }
                    );

                    await bot.sendMessage(
                        chatId,
                        text,
                        {
                            reply_markup:
                                keyboard()
                        }
                    );

                    return;
                }

                /* -----------------------------------------
                   UNKNOWN CALLBACK
                ----------------------------------------- */

                await bot.answerCallbackQuery(
                    query.id,
                    {
                        text:
                            "Unknown action."
                    }
                );

            } catch (error) {

                console.error(
                    "Callback error:",
                    error
                );
            }
        }
    );

    /* =====================================================
       MESSAGE STATE HANDLER
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

                const chatId =
                    String(
                        msg.chat.id
                    );

                const user =
                    getOrCreateUser(
                        msg.from
                    );

                /* =========================================
                   DEPOSIT STATE
                ========================================= */

                const depositState =
                    depositStates.get(
                        chatId
                    );

                if (depositState) {

                    if (
                        depositState.step ===
                        "amount"
                    ) {

                        const amount =
                            num(
                                msg.text
                            );

                        if (
                            amount <
                            MIN_DEPOSIT
                        ) {

                            await bot.sendMessage(
                                msg.chat.id,

                                `❌ Minimum deposit is ${MIN_DEPOSIT} ETB.`
                            );

                            return;
                        }

                        depositState.amount =
                            amount;

                        depositState.step =
                            "reference";

                        await bot.sendMessage(
                            msg.chat.id,

                            `💳 Deposit Amount:

${money(amount)} ETB

Please send your payment transaction/reference number.`,

                            {
                                reply_markup: {
                                    force_reply:
                                        true
                                }
                            }
                        );

                        return;
                    }

                    if (
                        depositState.step ===
                        "reference"
                    ) {

                        const reference =
                            String(
                                msg.text
                            ).trim();

                        if (
                            !reference
                        ) {

                            await bot.sendMessage(
                                msg.chat.id,
                                "❌ Reference cannot be empty."
                            );

                            return;
                        }

                        const amount =
                            num(
                                depositState.amount
                            );

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

                        depositStates.delete(
                            chatId
                        );

                        await bot.sendMessage(
                            msg.chat.id,

                            `✅ Deposit request submitted.

💰 Amount:
${money(amount)} ETB

🔖 Reference:
${reference}

⏳ Waiting for admin approval.`,

                            {
                                reply_markup:
                                    keyboard()
                            }
                        );

                        /*
                           Notify admin.
                        */

                        if (
                            ADMIN_CHAT_ID &&
                            bot
                        ) {

                            await bot.sendMessage(
                                ADMIN_CHAT_ID,

                                `💳 NEW DEPOSIT

👤 ${
                                    user.first_name ||
                                    ""
                                }

🆔 ${
                                    user.telegram_id
                                }

💰 ${
                                    money(amount)
                                } ETB

🔖 ${
                                    reference
                                }`,

                                {
                                    reply_markup: {
                                        inline_keyboard: [
                                            [
                                                {
                                                    text:
                                                        "✅ Approve",

                                                    callback_data:
                                                        `approve_deposit_${user.id}_${amount}_${reference}`
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
                   WITHDRAW STATE
                ========================================= */

                const withdrawState =
                    withdrawStates.get(
                        chatId
                    );

                if (withdrawState) {

                    if (
                        withdrawState.step ===
                        "amount"
                    ) {

                        const amount =
                            num(
                                msg.text
                            );

                        const fresh =
                            getUserById(
                                user.id
                            );

                        if (
                            amount <
                            MIN_WITHDRAW
                        ) {

                            await bot.sendMessage(
                                msg.chat.id,

                                `❌ Minimum withdrawal is ${MIN_WITHDRAW} ETB.`
                            );

                            return;
                        }

                        if (
                            amount >
                            Number(
                                fresh.balance
                            )
                        ) {

                            await bot.sendMessage(
                                msg.chat.id,

                                `❌ Insufficient Main Wallet balance.

Available:
${money(
    fresh.balance
)} ETB`
                            );

                            return;
                        }

                        withdrawState.amount =
                            amount;

                        withdrawState.step =
                            "account";

                        await bot.sendMessage(
                            msg.chat.id,

                            `💸 Withdrawal Amount:

${money(amount)} ETB

Enter your bank/mobile-money account details.`,

                            {
                                reply_markup: {
                                    force_reply:
                                        true
                                }
                            }
                        );

                        return;
                    }

                    if (
                        withdrawState.step ===
                        "account"
                    ) {

                        const details =
                            String(
                                msg.text
                            ).trim();

                        if (
                            !details
                        ) {

                            await bot.sendMessage(
                                msg.chat.id,
                                "❌ Account details cannot be empty."
                            );

                            return;
                        }

                        const amount =
                            num(
                                withdrawState.amount
                            );

                        /*
                           Reserve money immediately.

                           This prevents the same balance from
                           being withdrawn multiple times.
                        */

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

                            await bot.sendMessage(
                                msg.chat.id,

                                "❌ Balance changed. Please try again."
                            );

                            withdrawStates.delete(
                                chatId
                            );

                            return;
                        }

                        db.prepare(`
                            INSERT INTO withdrawals (
                                user_id,
                                amount,
                                account_details,
                                status,
                                telegram_id
                            )
                            VALUES (
                                ?,
                                ?,
                                ?,
                                'pending',
                                ?
                            )
                        `).run(
                            user.id,
                            amount,
                            details,
                            user.telegram_id
                        );

                        withdrawStates.delete(
                            chatId
                        );

                        await bot.sendMessage(
                            msg.chat.id,

                            `✅ Withdrawal request submitted.

💸 Amount:
${money(amount)} ETB

🏦 Account:
${details}

⏳ Waiting for admin approval.`,

                            {
                                reply_markup:
                                    keyboard()
                            }
                        );

                        if (
                            ADMIN_CHAT_ID &&
                            bot
                        ) {

                            await bot.sendMessage(
                                ADMIN_CHAT_ID,

                                `💸 NEW WITHDRAWAL

👤 ${
                                    user.first_name ||
                                    ""
                                }

🆔 ${
                                    user.telegram_id
                                }

💰 ${
                                    money(amount)
                                } ETB

🏦 ${
                                    details
                                }`,

                                {
                                    reply_markup: {
                                        inline_keyboard: [
                                            [
                                                {
                                                    text:
                                                        "✅ Approve",

                                                    callback_data:
                                                        `approve_withdraw_${user.id}_${amount}`
                                                },

                                                {
                                                    text:
                                                        "❌ Reject",

                                                    callback_data:
                                                        `reject_withdraw_${user.id}_${amount}`
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
            }
        }
    );

    /* =====================================================
       ADMIN CALLBACKS
    ===================================================== */

    bot.on(
        "callback_query",
        async query => {

            try {

                const data =
                    String(
                        query.data || ""
                    );

                if (
                    !ADMIN_CHAT_ID ||
                    String(
                        query.message.chat.id
                    ) !==
                    String(
                        ADMIN_CHAT_ID
                    )
                ) {
                    return;
                }

                /* =========================================
                   APPROVE DEPOSIT
                ========================================= */

                if (
                    data.startsWith(
                        "approve_deposit_"
                    )
                ) {

                    const parts =
                        data.split("_");

                    /*
                       approve_deposit_user_amount_reference
                    */

                    const userId =
                        Number(
                            parts[2]
                        );

                    const amount =
                        num(
                            parts[3]
                        );

                    const reference =
                        parts
                            .slice(4)
                            .join("_");

                    const output =
                        db.transaction(() => {

                            const deposit =
                                db.prepare(`
                                    SELECT *
                                    FROM deposits
                                    WHERE
                                        user_id = ?
                                        AND reference = ?
                                        AND status = 'pending'
                                    ORDER BY id DESC
                                    LIMIT 1
                                `).get(
                                    userId,
                                    reference
                                );

                            if (!deposit) {

                                throw new Error(
                                    "Deposit not found or already processed."
                                );
                            }

                            db.prepare(`
                                UPDATE deposits
                                SET
                                    status = 'approved',
                                    approved_at =
                                        CURRENT_TIMESTAMP
                                WHERE id = ?
                            `).run(
                                deposit.id
                            );

                            const update =
                                db.prepare(`
                                    UPDATE users
                                    SET play_balance =
                                        play_balance + ?
                                    WHERE id = ?
                                `).run(
                                    amount,
                                    userId
                                );

                            if (
                                update.changes !== 1
                            ) {

                                throw new Error(
                                    "User balance update failed."
                                );
                            }

                            return {
                                amount
                            };

                        })();

                    await bot.answerCallbackQuery(
                        query.id,
                        {
                            text:
                                "Deposit approved."
                        }
                    );

                    const player =
                        getUserById(
                            userId
                        );

                    if (player) {

                        await bot.sendMessage(
                            player.telegram_id,

                            `✅ Deposit Approved

💰 Added to Play Wallet:
${money(
    output.amount
)} ETB

🎮 Play Wallet:
${money(
    player.play_balance
)} ETB`
                        );
                    }

                    await bot.editMessageReplyMarkup(
                        {
                            inline_keyboard: []
                        },
                        {
                            chat_id:
                                query.message.chat.id,
                            message_id:
                                query.message.message_id
                        }
                    );

                    return;
                }

                /* =========================================
                   APPROVE WITHDRAW
                ========================================= */

                if (
                    data.startsWith(
                        "approve_withdraw_"
                    )
                ) {

                    const parts =
                        data.split("_");

                    const userId =
                        Number(
                            parts[2]
                        );

                    const amount =
                        num(
                            parts[3]
                        );

                    const output =
                        db.transaction(() => {

                            const withdrawal =
                                db.prepare(`
                                    SELECT *
                                    FROM withdrawals
                                    WHERE
                                        user_id = ?
                                        AND amount = ?
                                        AND status = 'pending'
                                    ORDER BY id DESC
                                    LIMIT 1
                                `).get(
                                    userId,
                                    amount
                                );

                            if (
                                !withdrawal
                            ) {

                                throw new Error(
                                    "Withdrawal not found or already processed."
                                );
                            }

                            db.prepare(`
                                UPDATE withdrawals
                                SET
                                    status = 'approved',
                                    approved_at =
                                        CURRENT_TIMESTAMP
                                WHERE id = ?
                            `).run(
                                withdrawal.id
                            );

                            return {
                                amount
                            };

                        })();

                    await bot.answerCallbackQuery(
                        query.id,
                        {
                            text:
                                "Withdrawal approved."
                        }
                    );

                    const player =
                        getUserById(
                            userId
                        );

                    if (player) {

                        await bot.sendMessage(
                            player.telegram_id,

                            `✅ Withdrawal Approved

💸 Amount:
${money(
    output.amount
)} ETB

The withdrawal has been processed.`
                        );
                    }

                    await bot.editMessageReplyMarkup(
                        {
                            inline_keyboard: []
                        },
                        {
                            chat_id:
                                query.message.chat.id,
                            message_id:
                                query.message.message_id
                        }
                    );

                    return;
                }

                /* =========================================
                   REJECT WITHDRAW
                ========================================= */

                if (
                    data.startsWith(
                        "reject_withdraw_"
                    )
                ) {

                    const parts =
                        data.split("_");

                    const userId =
                        Number(
                            parts[2]
                        );

                    const amount =
                        num(
                            parts[3]
                        );

                    const output =
                        db.transaction(() => {

                            const withdrawal =
                                db.prepare(`
                                    SELECT *
                                    FROM withdrawals
                                    WHERE
                                        user_id = ?
                                        AND amount = ?
                                        AND status = 'pending'
                                    ORDER BY id DESC
                                    LIMIT 1
                                `).get(
                                    userId,
                                    amount
                                );

                            if (
                                !withdrawal
                            ) {

                                throw new Error(
                                    "Withdrawal not found or already processed."
                                );
                            }

                            db.prepare(`
                                UPDATE withdrawals
                                SET
                                    status = 'rejected',
                                    approved_at =
                                        CURRENT_TIMESTAMP
                                WHERE id = ?
                            `).run(
                                withdrawal.id
                            );

                            /*
                               Refund rejected withdrawal
                               to Main Wallet.
                            */

                            const refund =
                                db.prepare(`
                                    UPDATE users
                                    SET balance =
                                        balance + ?
                                    WHERE id = ?
                                `).run(
                                    amount,
                                    userId
                                );

                            if (
                                refund.changes !== 1
                            ) {

                                throw new Error(
                                    "Withdrawal refund failed."
                                );
                            }

                            return {
                                amount
                            };

                        })();

                    await bot.answerCallbackQuery(
                        query.id,
                        {
                            text:
                                "Withdrawal rejected and refunded."
                        }
                    );

                    const player =
                        getUserById(
                            userId
                        );

                    if (player) {

                        await bot.sendMessage(
                            player.telegram_id,

                            `❌ Withdrawal Rejected

💰 Refunded to Main Wallet:
${money(
    output.amount
)} ETB

Main Wallet:
${money(
    player.balance
)} ETB`
                        );
                    }

                    await bot.editMessageReplyMarkup(
                        {
                            inline_keyboard: []
                        },
                        {
                            chat_id:
                                query.message.chat.id,
                            message_id:
                                query.message.message_id
                        }
                    );

                    return;
                }

            } catch (error) {

                console.error(
                    "Admin callback error:",
                    error
                );

                try {

                    await bot.answerCallbackQuery(
                        query.id,
                        {
                            text:
                                "❌ Action failed."
                        }
                    );

                } catch (_) {}
            }
        }
    );

    /* =====================================================
       POLLING ERROR
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
            "🏆 Winner → 85% of TOTAL MATCH COST"
        );

        console.log(
            "👥 Multiple Winners → Prize divided equally"
        );

        console.log(
            "💸 Withdrawal → MAIN WALLET ONLY"
        );

        console.log(
            "===================================="
        );
    }
);
